import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hostEnv } from "../../src/core/hostEnv";

export type CollectorTls = {
  /** The company's own certificate authority, as a PEM file and its text. */
  caPath: string;
  ca: string;
  /** The collector's certificate for 127.0.0.1, signed by that authority. */
  serverCert: string;
  serverKey: string;
  /** A developer's client certificate and key, signed by the same authority. */
  clientCertPath: string;
  clientKeyPath: string;
};

/**
 * A company collector's certificates, made by OpenSSL under the caller's
 * scratch folder: an authority no computer trusts, a server certificate for
 * the loopback address the stand-in collectors listen on, and a client
 * certificate for a collector that asks for one.
 */
export function collectorTlsFixture(dir: string): CollectorTls {
  const run = (args: string[]) =>
    execFileSync("openssl", args, { cwd: dir, env: { ...hostEnv(), HOME: dir }, stdio: "pipe" });
  writeFileSync(
    join(dir, "ca.cnf"),
    "[req]\ndistinguished_name=dn\nx509_extensions=ca\nprompt=no\n[dn]\nCN=Company collector CA\n[ca]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\nsubjectKeyIdentifier=hash\n",
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
    "ca.cnf",
  ]);
  const issue = (name: string, subject: string, extensions: string) => {
    run([
      "req",
      "-new",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      `${name}.key`,
      "-out",
      `${name}.csr`,
      "-subj",
      subject,
    ]);
    writeFileSync(join(dir, `${name}.ext`), extensions, { mode: 0o600 });
    run([
      "x509",
      "-req",
      "-in",
      `${name}.csr`,
      "-CA",
      "ca.pem",
      "-CAkey",
      "ca.key",
      "-set_serial",
      name === "server" ? "2" : "3",
      "-out",
      `${name}.pem`,
      "-days",
      "1",
      "-extfile",
      `${name}.ext`,
    ]);
  };
  // The authority key identifier is named explicitly: OpenSSL 4 and LibreSSL add none of their own.
  issue(
    "server",
    "/CN=collector.example.test",
    "basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:127.0.0.1\nauthorityKeyIdentifier=keyid\n",
  );
  issue(
    "client",
    "/CN=dev@example.com",
    "basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=clientAuth\nauthorityKeyIdentifier=keyid\n",
  );
  return {
    caPath: join(dir, "ca.pem"),
    ca: readFileSync(join(dir, "ca.pem"), "utf8"),
    serverCert: readFileSync(join(dir, "server.pem"), "utf8"),
    serverKey: readFileSync(join(dir, "server.key"), "utf8"),
    clientCertPath: join(dir, "client.pem"),
    clientKeyPath: join(dir, "client.key"),
  };
}
