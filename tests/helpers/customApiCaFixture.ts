import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hostEnv } from "../../src/core/hostEnv";

/** Synthetic certificate authority/server keys under the caller's scratch HOME. */
export function customApiCaFixture(dir: string) {
  const run = (args: string[]) =>
    execFileSync("openssl", args, {
      cwd: dir,
      env: { ...hostEnv(), HOME: dir, INFINITARY_LOCAL_CODESIGN_DIR: join(dir, "signing") },
      stdio: "pipe",
    });
  // Both CAs share a subject, so the key identifiers are named explicitly:
  // OpenSSL 4 and LibreSSL add none of their own, and without them a verifier
  // picks the sibling CA by name and reports a signature failure instead.
  writeFileSync(
    join(dir, "root.cnf"),
    "[req]\ndistinguished_name=dn\nx509_extensions=ca\nprompt=no\n[dn]\nCN=Firstmate synthetic CA\n[ca]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\nsubjectKeyIdentifier=hash\n",
    { mode: 0o600 },
  );
  run([
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    "ca.key",
    "-out",
    "ca.pem",
    "-days",
    "2",
    "-config",
    "root.cnf",
  ]);
  run([
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    "other.key",
    "-out",
    "other.pem",
    "-days",
    "2",
    "-config",
    "root.cnf",
  ]);
  run([
    "req",
    "-new",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    "leaf.key",
    "-out",
    "leaf.csr",
    "-subj",
    "/CN=gateway.example.test",
  ]);
  writeFileSync(
    join(dir, "leaf.ext"),
    "basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:gateway.example.test\nauthorityKeyIdentifier=keyid\n",
    { mode: 0o600 },
  );
  run([
    "x509",
    "-req",
    "-in",
    "leaf.csr",
    "-CA",
    "ca.pem",
    "-CAkey",
    "ca.key",
    "-set_serial",
    "2",
    "-out",
    "leaf.pem",
    "-days",
    "1",
    "-extfile",
    "leaf.ext",
  ]);
  // A fixed past validity period is portable across OpenSSL versions; a
  // negative -days is rejected by newer versions rather than making expiry.
  mkdirSync(join(dir, "issued"), { mode: 0o700 });
  writeFileSync(join(dir, "index"), "", { mode: 0o600 });
  writeFileSync(join(dir, "serial"), "03\n", { mode: 0o600 });
  writeFileSync(
    join(dir, "expired.cnf"),
    "[ca]\ndefault_ca=local\n[local]\ndatabase=index\nserial=serial\nnew_certs_dir=issued\nprivate_key=ca.key\ncertificate=ca.pem\ndefault_md=sha256\npolicy=policy\nx509_extensions=ext\n[policy]\ncommonName=supplied\n[ext]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:gateway.example.test\nauthorityKeyIdentifier=keyid\n",
    { mode: 0o600 },
  );
  run([
    "ca",
    "-config",
    "expired.cnf",
    "-batch",
    "-in",
    "leaf.csr",
    "-out",
    "expired.pem",
    "-startdate",
    "20000101000000Z",
    "-enddate",
    "20000102000000Z",
    "-notext",
  ]);
  const ca = readFileSync(join(dir, "ca.pem"), "utf8");
  const otherCa = readFileSync(join(dir, "other.pem"), "utf8");
  const leaf = readFileSync(join(dir, "leaf.pem"), "utf8");
  const leafKey = readFileSync(join(dir, "leaf.key"), "utf8");
  const expired = readFileSync(join(dir, "expired.pem"), "utf8");
  // The same leaf with one bit of its signature flipped, in Node rather than
  // OpenSSL so every OpenSSL version gives the same damaged certificate.
  const der = Buffer.from(leaf.replace(/-----[A-Z ]+-----|\s/g, ""), "base64");
  der.writeUInt8(der.readUInt8(der.length - 1) ^ 1, der.length - 1);
  const lines = der.toString("base64").match(/.{1,64}/g) ?? [];
  const badSignature = `-----BEGIN CERTIFICATE-----\n${lines.join("\n")}\n-----END CERTIFICATE-----\n`;
  return { ca, otherCa, leaf, leafKey, expired, badSignature };
}
