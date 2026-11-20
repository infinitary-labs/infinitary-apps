import { chmod, copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

/** Stage the system policy before fpm reads it, independently of the checkout's file mode. */
export default async function preparePolicy(context) {
  if (context.electronPlatformName !== "linux") return;
  const root = context.packager.projectDir;
  const policy = "app.infinitary.secrets.approve.policy";
  const staged = join(root, "packaging/generated/linux", policy);
  await mkdir(dirname(staged), { recursive: true });
  await copyFile(join(root, "packaging/linux/polkit", policy), staged);
  await chmod(staged, 0o644);
}
