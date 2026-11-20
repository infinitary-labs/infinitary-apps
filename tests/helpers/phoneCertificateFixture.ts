import { execFileSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hostEnv } from "../../src/core/hostEnv";
import { scratchDir } from "./scratchDirs";

/** INF-259: disposable, real X.509 readings, never tracked certificate/key files. */
export function phoneCertificateFixture(): Record<string, X509Certificate> {
  const root = scratchDir("phone-certificates-");
  const run = (args: string[]) =>
    execFileSync("openssl", args, {
      cwd: root,
      env: {
        ...hostEnv(),
        HOME: root,
        CFFIXED_USER_HOME: root,
        INFINITARY_LOCAL_CODESIGN_DIR: join(root, "signing"),
      },
      stdio: "pipe",
    });
  run([
    "req",
    "-x509",
    "-newkey",
    "ec",
    "-pkeyopt",
    "ec_paramgen_curve:prime256v1",
    "-nodes",
    "-keyout",
    "ca.key",
    "-out",
    "ca.pem",
    "-days",
    "1",
    "-subj",
    "/CN=Disposable phone cleanup CA",
  ]);
  mkdirSync(join(root, "issued"));
  writeFileSync(join(root, "index"), "");
  writeFileSync(join(root, "serial"), "01\n");
  writeFileSync(
    join(root, "ca.cnf"),
    "[ca]\ndefault_ca=local\n[local]\ndatabase=index\nserial=serial\nnew_certs_dir=issued\nprivate_key=ca.key\ncertificate=ca.pem\ndefault_md=sha256\npolicy=policy\n[policy]\ncommonName=supplied\n",
  );
  const certificates: Record<string, X509Certificate> = {};
  for (const [name, cn] of Object.entries({
    api: "Apple Development: Created via API (A1B2C3D4E5)",
    person: "Apple Development: Fixture Person",
    "other-key": "Apple Development: Created via API (Z9Y8X7W6V5)",
  })) {
    run([
      "req",
      "-new",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
      "-nodes",
      "-keyout",
      `${name}.key`,
      "-out",
      `${name}.csr`,
      "-subj",
      `/CN=${cn}`,
    ]);
    // ca's explicit validity works on both macOS and Linux OpenSSL versions.
    run([
      "ca",
      "-config",
      "ca.cnf",
      "-batch",
      "-in",
      `${name}.csr`,
      "-out",
      `${name}.pem`,
      "-startdate",
      "20260919000000Z",
      "-enddate",
      "20360919000000Z",
      "-notext",
    ]);
    certificates[name] = new X509Certificate(readFileSync(join(root, `${name}.pem`)));
  }
  return certificates;
}
