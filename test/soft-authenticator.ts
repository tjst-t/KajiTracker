// テスト用のパスキー（ES256・attestation none）。本物の端末の代わりに、登録とログインの応答を作る
import { isoBase64URL, isoCBOR, isoUint8Array } from "@simplewebauthn/server/helpers";
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";

const sha256 = async (b: Uint8Array) => new Uint8Array(await crypto.subtle.digest("SHA-256", b as Uint8Array<ArrayBuffer>));
const u32 = (n: number) => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);

/** WebCrypto の署名（r||s）を WebAuthn の DER に直す */
function rawToDer(raw: Uint8Array): Uint8Array<ArrayBuffer> {
  const int = (b: Uint8Array) => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    let v = b.slice(i);
    if (v[0]! & 0x80) v = isoUint8Array.concat([new Uint8Array([0]), v]);
    return isoUint8Array.concat([new Uint8Array([0x02, v.length]), v]);
  };
  const body = isoUint8Array.concat([int(raw.slice(0, 32)), int(raw.slice(32))]);
  return isoUint8Array.concat([new Uint8Array([0x30, body.length]), body]) as Uint8Array<ArrayBuffer>;
}

export class SoftAuthenticator {
  private keys!: CryptoKeyPair;
  readonly credentialId = crypto.getRandomValues(new Uint8Array(16));
  private userHandle = "";
  private counter = 0;

  get id() {
    return isoBase64URL.fromBuffer(this.credentialId);
  }

  async register(opts: PublicKeyCredentialCreationOptionsJSON, origin: string): Promise<RegistrationResponseJSON> {
    this.keys = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
    this.userHandle = opts.user.id;
    const raw = new Uint8Array((await crypto.subtle.exportKey("raw", this.keys.publicKey)) as ArrayBuffer);
    const cose = new Map<number, number | Uint8Array>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, raw.slice(1, 33)],
      [-3, raw.slice(33, 65)],
    ]);
    const authData = isoUint8Array.concat([
      await sha256(isoUint8Array.fromUTF8String(opts.rp.id!)),
      new Uint8Array([0x45]), // UP | UV | AT
      u32(this.counter),
      new Uint8Array(16), // aaguid
      new Uint8Array([0, this.credentialId.length]),
      this.credentialId,
      isoCBOR.encode(cose),
    ]);
    const attestationObject = isoCBOR.encode(
      new Map<string, unknown>([
        ["fmt", "none"],
        ["attStmt", new Map()],
        ["authData", authData],
      ]) as never,
    );
    const clientDataJSON = isoUint8Array.fromUTF8String(JSON.stringify({ type: "webauthn.create", challenge: opts.challenge, origin, crossOrigin: false }));
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key",
      response: {
        clientDataJSON: isoBase64URL.fromBuffer(clientDataJSON),
        attestationObject: isoBase64URL.fromBuffer(attestationObject),
        transports: ["internal"],
      },
      clientExtensionResults: {},
    };
  }

  async authenticate(opts: PublicKeyCredentialRequestOptionsJSON, origin: string, rpId = opts.rpId!): Promise<AuthenticationResponseJSON> {
    this.counter++;
    const authData = isoUint8Array.concat([await sha256(isoUint8Array.fromUTF8String(rpId)), new Uint8Array([0x05]), u32(this.counter)]);
    const clientDataJSON = isoUint8Array.fromUTF8String(JSON.stringify({ type: "webauthn.get", challenge: opts.challenge, origin, crossOrigin: false }));
    const signed = isoUint8Array.concat([authData, await sha256(clientDataJSON)]);
    const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, this.keys.privateKey, signed as Uint8Array<ArrayBuffer>));
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key",
      response: {
        clientDataJSON: isoBase64URL.fromBuffer(clientDataJSON),
        authenticatorData: isoBase64URL.fromBuffer(authData),
        signature: isoBase64URL.fromBuffer(rawToDer(sig)),
        userHandle: this.userHandle,
      },
      clientExtensionResults: {},
    };
  }
}
