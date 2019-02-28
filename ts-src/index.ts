import * as crypto from './crypto'
const bs58check = require('bs58check')
const ecc = require('tiny-secp256k1')
const typeforce = require('typeforce')
const wif = require('wif')

type Network = {
  wif: number
  bip32: {
    public: number
    private: number
  }
  messagePrefix?: string
  bech32?: string
  pubKeyHash?: number
  scriptHash?: number
}

const UINT256_TYPE = typeforce.BufferN(32)
const NETWORK_TYPE = typeforce.compile({
  wif: typeforce.UInt8,
  bip32: {
    public: typeforce.UInt32,
    private: typeforce.UInt32
  }
})

const BITCOIN = {
  wif: 0x80,
  bip32: {
    public: 0x0488b21e,
    private: 0x0488ade4
  }
}

const HIGHEST_BIT = 0x80000000
const UINT31_MAX = Math.pow(2, 31) - 1

function BIP32Path (value: string): boolean {
  return typeforce.String(value) && value.match(/^(m\/)?(\d+'?\/)*\d+'?$/) !== null
}

function UInt31 (value: number): boolean {
  return typeforce.UInt32(value) && value <= UINT31_MAX
}

export interface BIP32Interface {
  chainCode: Buffer
  network: Network
  depth: number
  index: number
  parentFingerprint: number
  publicKey: Buffer
  privateKey?: Buffer
  identifier: Buffer
  fingerprint: Buffer
  isNeutered (): boolean
  neutered (): BIP32Interface
  toBase58 (): string
  toWIF (): string
  derive (index: number): BIP32Interface
  deriveHardened (index: number): BIP32Interface
  derivePath (path: string): BIP32Interface
  sign (hash: Buffer): Buffer
  verify (hash: Buffer, signature: Buffer): boolean
}

class BIP32 implements BIP32Interface {
  private __d?: Buffer
  private __Q?: Buffer
  chainCode: Buffer
  network: Network
  depth: number
  index: number
  parentFingerprint: number

  constructor (d: Buffer | undefined, Q: Buffer | undefined, chainCode: Buffer, network: Network) {
    typeforce(NETWORK_TYPE, network)

    this.chainCode = chainCode
    this.depth = 0
    this.index = 0
    this.network = network
    this.parentFingerprint = 0x00000000

    this.__d = undefined
    this.__Q = undefined
    if (d !== undefined) this.__d = d
    if (Q !== undefined) this.__Q = Q
  }

  get publicKey (): Buffer {
    if (this.__Q === undefined) this.__Q = ecc.pointFromScalar(this.__d, true)
    return <Buffer> this.__Q
  }

  get privateKey (): Buffer | undefined {
    return this.__d
  }

  get identifier (): Buffer {
    return crypto.hash160(this.publicKey)
  }

  get fingerprint (): Buffer {
    return this.identifier.slice(0, 4)
  }

  // Private === not neutered
  // Public === neutered
  isNeutered (): boolean {
    return this.__d === undefined
  }

  neutered (): BIP32Interface {
    let neutered = fromPublicKey(this.publicKey, this.chainCode, this.network)
    neutered.depth = this.depth
    neutered.index = this.index
    neutered.parentFingerprint = this.parentFingerprint
    return neutered
  }

  toBase58 (): string {
    let network = this.network
    let version = (!this.isNeutered()) ? network.bip32.private : network.bip32.public
    let buffer = Buffer.allocUnsafe(78)

    // 4 bytes: version bytes
    buffer.writeUInt32BE(version, 0)

    // 1 byte: depth: 0x00 for master nodes, 0x01 for level-1 descendants, ....
    buffer.writeUInt8(this.depth, 4)

    // 4 bytes: the fingerprint of the parent's key (0x00000000 if master key)
    buffer.writeUInt32BE(this.parentFingerprint, 5)

    // 4 bytes: child number. This is the number i in xi = xpar/i, with xi the key being serialized.
    // This is encoded in big endian. (0x00000000 if master key)
    buffer.writeUInt32BE(this.index, 9)

    // 32 bytes: the chain code
    this.chainCode.copy(buffer, 13)

    // 33 bytes: the public key or private key data
    if (!this.isNeutered()) {
      // 0x00 + k for private keys
      buffer.writeUInt8(0, 45)
      ;(<Buffer> this.privateKey).copy(buffer, 46)

    // 33 bytes: the public key
    } else {
      // X9.62 encoding for public keys
      this.publicKey.copy(buffer, 45)
    }

    return bs58check.encode(buffer)
  }

  toWIF (): string {
    if (!this.privateKey) throw new TypeError('Missing private key')
    return wif.encode(this.network.wif, this.privateKey, true)
  }

  // https://github.com/bitcoin/bips/blob/master/bip-0032.mediawiki#child-key-derivation-ckd-functions
  derive (index: number): BIP32Interface {
    typeforce(typeforce.UInt32, index)

    let isHardened = index >= HIGHEST_BIT
    let data = Buffer.allocUnsafe(37)

    // Hardened child
    if (isHardened) {
      if (this.isNeutered()) throw new TypeError('Missing private key for hardened child key')

      // data = 0x00 || ser256(kpar) || ser32(index)
      data[0] = 0x00
      ;(<Buffer> this.privateKey).copy(data, 1)
      data.writeUInt32BE(index, 33)

    // Normal child
    } else {
      // data = serP(point(kpar)) || ser32(index)
      //      = serP(Kpar) || ser32(index)
      this.publicKey.copy(data, 0)
      data.writeUInt32BE(index, 33)
    }

    let I = crypto.hmacSHA512(this.chainCode, data)
    let IL = I.slice(0, 32)
    let IR = I.slice(32)

    // if parse256(IL) >= n, proceed with the next value for i
    if (!ecc.isPrivate(IL)) return this.derive(index + 1)

    // Private parent key -> private child key
    let hd: BIP32Interface
    if (!this.isNeutered()) {
      // ki = parse256(IL) + kpar (mod n)
      let ki = ecc.privateAdd(this.privateKey, IL)

      // In case ki == 0, proceed with the next value for i
      if (ki == null) return this.derive(index + 1)

      hd = fromPrivateKey(ki, IR, this.network)

    // Public parent key -> public child key
    } else {
      // Ki = point(parse256(IL)) + Kpar
      //    = G*IL + Kpar
      let Ki = ecc.pointAddScalar(this.publicKey, IL, true)

      // In case Ki is the point at infinity, proceed with the next value for i
      if (Ki === null) return this.derive(index + 1)

      hd = fromPublicKey(Ki, IR, this.network)
    }

    hd.depth = this.depth + 1
    hd.index = index
    hd.parentFingerprint = this.fingerprint.readUInt32BE(0)
    return hd
  }

  deriveHardened (index: number): BIP32Interface {
    typeforce(UInt31, index)

    // Only derives hardened private keys by default
    return this.derive(index + HIGHEST_BIT)
  }

  derivePath (path: string): BIP32Interface {
    typeforce(BIP32Path, path)

    let splitPath = path.split('/')
    if (splitPath[0] === 'm') {
      if (this.parentFingerprint) throw new TypeError('Expected master, got child')

      splitPath = splitPath.slice(1)
    }

    return splitPath.reduce(function (prevHd, indexStr) {
      let index
      if (indexStr.slice(-1) === "'") {
        index = parseInt(indexStr.slice(0, -1), 10)
        return prevHd.deriveHardened(index)
      } else {
        index = parseInt(indexStr, 10)
        return prevHd.derive(index)
      }
    }, <BIP32Interface> this)
  }

  sign (hash: Buffer): Buffer {
    return ecc.sign(hash, this.privateKey)
  }

  verify (hash: Buffer, signature: Buffer): boolean {
    return ecc.verify(hash, this.publicKey, signature)
  }
}

export function fromBase58 (string: string, network?: Network): BIP32Interface {
  let buffer = bs58check.decode(string)
  if (buffer.length !== 78) throw new TypeError('Invalid buffer length')
  network = <Network> (network || BITCOIN)

  // 4 bytes: version bytes
  let version = buffer.readUInt32BE(0)
  if (version !== network.bip32.private &&
    version !== network.bip32.public) throw new TypeError('Invalid network version')

  // 1 byte: depth: 0x00 for master nodes, 0x01 for level-1 descendants, ...
  let depth = buffer[4]

  // 4 bytes: the fingerprint of the parent's key (0x00000000 if master key)
  let parentFingerprint = buffer.readUInt32BE(5)
  if (depth === 0) {
    if (parentFingerprint !== 0x00000000) throw new TypeError('Invalid parent fingerprint')
  }

  // 4 bytes: child number. This is the number i in xi = xpar/i, with xi the key being serialized.
  // This is encoded in MSB order. (0x00000000 if master key)
  let index = buffer.readUInt32BE(9)
  if (depth === 0 && index !== 0) throw new TypeError('Invalid index')

  // 32 bytes: the chain code
  let chainCode = buffer.slice(13, 45)
  let hd

  // 33 bytes: private key data (0x00 + k)
  if (version === network.bip32.private) {
    if (buffer.readUInt8(45) !== 0x00) throw new TypeError('Invalid private key')
    let k = buffer.slice(46, 78)

    hd = fromPrivateKey(k, chainCode, network)

  // 33 bytes: public key data (0x02 + X or 0x03 + X)
  } else {
    let X = buffer.slice(45, 78)

    hd = fromPublicKey(X, chainCode, network)
  }

  hd.depth = depth
  hd.index = index
  hd.parentFingerprint = parentFingerprint
  return hd
}

export function fromPrivateKey (privateKey: Buffer, chainCode: Buffer, network?: Network): BIP32Interface {
  typeforce({
    privateKey: UINT256_TYPE,
    chainCode: UINT256_TYPE
  }, { privateKey, chainCode })
  network = <Network> (network || BITCOIN)

  if (!ecc.isPrivate(privateKey)) throw new TypeError('Private key not in range [1, n)')
  return new BIP32(privateKey, undefined, chainCode, network)
}

export function fromPublicKey (publicKey: Buffer, chainCode: Buffer, network?: Network): BIP32Interface {
  typeforce({
    publicKey: typeforce.BufferN(33),
    chainCode: UINT256_TYPE
  }, { publicKey, chainCode })
  network = <Network> (network || BITCOIN)

  // verify the X coordinate is a point on the curve
  if (!ecc.isPoint(publicKey)) throw new TypeError('Point is not on the curve')
  return new BIP32(undefined, publicKey, chainCode, network)
}

export function fromSeed (seed: Buffer, network?: Network): BIP32Interface {
  typeforce(typeforce.Buffer, seed)
  if (seed.length < 16) throw new TypeError('Seed should be at least 128 bits')
  if (seed.length > 64) throw new TypeError('Seed should be at most 512 bits')
  network = <Network> (network || BITCOIN)

  let I = crypto.hmacSHA512(Buffer.from('Bitcoin seed', 'utf8'), seed)
  let IL = I.slice(0, 32)
  let IR = I.slice(32)

  return fromPrivateKey(IL, IR, network)
}
