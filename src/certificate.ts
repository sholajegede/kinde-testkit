import { createHash, generateKeyPairSync, randomBytes, sign, X509Certificate } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export interface LocalCertificate {
  cert: string;
  key: string;
  certPath: string;
  keyPath: string;
  created: boolean;
}

const CERT_FILE = "localhost-cert.pem";
const KEY_FILE = "localhost-key.pem";
const VALID_DAYS = 825;

export function ensureLocalCertificate(directory = ".kinde-testkit"): LocalCertificate {
  const dir = resolve(directory);
  const certPath = join(dir, CERT_FILE);
  const keyPath = join(dir, KEY_FILE);
  if (existsSync(certPath) && existsSync(keyPath)) {
    const cert = readFileSync(certPath, "utf8");
    const key = readFileSync(keyPath, "utf8");
    try {
      if (new Date(new X509Certificate(cert).validTo).getTime() > Date.now() + 86_400_000) {
        return { cert, key, certPath, keyPath, created: false };
      }
    } catch {
      // regenerate below
    }
  }
  const { cert, key } = createLocalCertificate();
  mkdirSync(dir, { recursive: true });
  writeFileSync(certPath, cert);
  writeFileSync(keyPath, key, { mode: 0o600 });
  writeFileSync(join(dir, ".gitignore"), "*\n");
  return { cert, key, certPath, keyPath, created: true };
}

export function createLocalCertificate(): { cert: string; key: string } {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const spki = publicKey.export({ type: "spki", format: "der" });
  const keyId = createHash("sha1").update(subjectPublicKeyBits(spki)).digest();
  const name = seq(set(seq(oid("2.5.4.3"), tlv(0x0c, Buffer.from("kinde-testkit localhost")))));
  const now = Date.now();
  const algorithm = seq(oid("1.2.840.113549.1.1.11"), tlv(0x05, Buffer.alloc(0)));
  const serial = randomBytes(16);
  serial[0]! &= 0x7f;

  const extensions = seq(
    seq(oid("2.5.29.19"), tlv(0x01, Buffer.from([0xff])), octets(seq(tlv(0x01, Buffer.from([0xff]))))),
    seq(oid("2.5.29.14"), octets(octets(keyId))),
    seq(oid("2.5.29.35"), octets(seq(tlv(0x80, keyId)))),
    seq(
      oid("2.5.29.17"),
      octets(
        seq(
          tlv(0x82, Buffer.from("localhost")),
          tlv(0x87, Buffer.from([127, 0, 0, 1])),
          tlv(0x87, Buffer.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1])),
        ),
      ),
    ),
  );

  const tbs = seq(
    tlv(0xa0, integer(Buffer.from([2]))),
    integer(serial),
    algorithm,
    name,
    seq(utcTime(new Date(now - 60_000)), utcTime(new Date(now + VALID_DAYS * 86_400_000))),
    name,
    spki,
    tlv(0xa3, extensions),
  );
  const signature = sign("sha256", tbs, privateKey);
  const der = seq(tbs, algorithm, tlv(0x03, Buffer.concat([Buffer.from([0]), signature])));

  return {
    cert: pem("CERTIFICATE", der),
    key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

function subjectPublicKeyBits(spki: Buffer): Buffer {
  const outer = readTlv(spki, 0);
  const algorithm = readTlv(spki, outer.start);
  const bits = readTlv(spki, algorithm.end);
  return spki.subarray(bits.start + 1, bits.end);
}

function readTlv(buf: Buffer, offset: number): { start: number; end: number } {
  let len = buf[offset + 1]!;
  let header = 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    len = 0;
    for (let i = 0; i < n; i++) len = (len << 8) | buf[offset + 2 + i]!;
    header += n;
  }
  return { start: offset + header, end: offset + header + len };
}

function tlv(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), length(content.length), content]);
}

function length(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n >>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function seq(...items: Buffer[]): Buffer {
  return tlv(0x30, Buffer.concat(items));
}

function set(...items: Buffer[]): Buffer {
  return tlv(0x31, Buffer.concat(items));
}

function octets(content: Buffer): Buffer {
  return tlv(0x04, content);
}

function integer(bytes: Buffer): Buffer {
  return tlv(0x02, bytes[0]! & 0x80 ? Buffer.concat([Buffer.from([0]), bytes]) : bytes);
}

function oid(dotted: string): Buffer {
  const parts = dotted.split(".").map(Number);
  const bytes = [parts[0]! * 40 + parts[1]!];
  for (const part of parts.slice(2)) {
    const chunk = [part & 0x7f];
    let value = part >> 7;
    while (value > 0) {
      chunk.unshift((value & 0x7f) | 0x80);
      value >>= 7;
    }
    bytes.push(...chunk);
  }
  return tlv(0x06, Buffer.from(bytes));
}

function utcTime(date: Date): Buffer {
  const iso = date.toISOString();
  const value = `${iso.slice(2, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`;
  return tlv(0x17, Buffer.from(value));
}

function pem(label: string, der: Buffer): string {
  const body = der.toString("base64").match(/.{1,64}/g)!.join("\n");
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
}
