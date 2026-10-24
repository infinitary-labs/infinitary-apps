import koffi from "koffi";
import { hostPlatform } from "../../core/platform";
import type { FreshAuthentication } from "../../core/secrets/approvals";

/**
 * Fresh system authentication on macOS (docs/secrets.md, "Trusted
 * approvals"): LocalAuthentication's device-owner policy - Touch ID, a paired
 * watch, or the login password - asked through a new context every time, so
 * nothing an earlier approval unlocked is reused. A dismissed, failed or
 * impossible confirmation approves nothing.
 */

/** LAPolicyDeviceOwnerAuthentication */
const DEVICE_OWNER = 2;

type LocalAuthentication = {
  canEvaluate(): boolean;
  evaluate(reason: string, interactionNotAllowed: boolean): Promise<boolean>;
};

export type DarwinAuthenticationOptions = {
  /**
   * Never show the system's prompt: the confirmation then always fails. For a
   * check that the binding answers without a person, never for the app.
   */
  interactionNotAllowed?: boolean;
};

export function createDarwinFreshAuthentication(
  options: DarwinAuthenticationOptions = {},
): FreshAuthentication | undefined {
  if (hostPlatform() !== "darwin") return undefined;
  try {
    binding ??= bindLocalAuthentication();
  } catch {
    return undefined;
  }
  const bound = binding;
  return {
    available: async () => {
      try {
        return bound.canEvaluate();
      } catch {
        return false;
      }
    },
    confirm: async (reason) => {
      try {
        return await bound.evaluate(reason, options.interactionNotAllowed === true);
      } catch {
        return false;
      }
    },
  };
}

/** One binding per process: koffi registers its types once, and the block lives as long. */
let binding: LocalAuthentication | undefined;

function bindLocalAuthentication(): LocalAuthentication {
  const objc = koffi.load("/usr/lib/libobjc.A.dylib");
  koffi.load("/System/Library/Frameworks/LocalAuthentication.framework/LocalAuthentication");
  koffi.load("/System/Library/Frameworks/Foundation.framework/Foundation");
  const system = koffi.load("/usr/lib/libSystem.B.dylib");
  const getClass = objc.func("objc_getClass", "void *", ["const char *"]);
  const selector = objc.func("sel_registerName", "void *", ["const char *"]);
  const send = objc.func("objc_msgSend", "void *", ["void *", "void *"]);
  const sendBool = objc.func("objc_msgSend", "void", ["void *", "void *", "uint8"]);
  const sendString = objc.func("objc_msgSend", "void *", ["void *", "void *", "const char *"]);
  const canEvaluate = objc.func("objc_msgSend", "uint8", [
    "void *",
    "void *",
    "long",
    koffi.out(koffi.pointer("void *")),
  ]);
  const evaluate = objc.func("objc_msgSend", "void", [
    "void *",
    "void *",
    "long",
    "void *",
    "void *",
  ]);
  // A global block literal, as a compiler makes for a block that captures nothing.
  // LocalAuthentication reads it again after the reply returns, so it lives as
  // long as the binding, and one confirmation runs at a time.
  const Reply = koffi.proto("void InfinitarySecretsLAReply(void *block, uint8 ok, void *error)");
  const Descriptor = koffi.struct("InfinitarySecretsBlockDescriptor", {
    reserved: "ulong",
    size: "ulong",
  });
  const Block = koffi.struct("InfinitarySecretsBlockLiteral", {
    isa: "void *",
    flags: "int",
    reserved: "int",
    invoke: koffi.pointer(Reply),
    descriptor: koffi.pointer(Descriptor),
  });
  /** BLOCK_IS_GLOBAL: never copied and never freed by the runtime. */
  const BLOCK_IS_GLOBAL = 1 << 28;
  let replied: ((ok: boolean) => void) | undefined;
  const callback = koffi.register((_block: unknown, ok: number) => {
    const answer = replied;
    replied = undefined;
    answer?.(ok === 1);
  }, koffi.pointer(Reply));
  const descriptor = koffi.alloc(Descriptor, 1);
  koffi.encode(descriptor, Descriptor, { reserved: 0, size: koffi.sizeof(Block) });
  const block = koffi.alloc(Block, 1);
  koffi.encode(block, Block, {
    isa: system.symbol("_NSConcreteGlobalBlock"),
    flags: BLOCK_IS_GLOBAL,
    reserved: 0,
    invoke: callback,
    descriptor,
  });

  const context = () => {
    const made = send(send(getClass("LAContext"), selector("alloc")), selector("init"));
    if (made == null) throw new Error("LocalAuthentication made no context");
    return made;
  };
  const release = (object: unknown) => send(object, selector("release"));
  const evaluateOnce = (reason: string, interactionNotAllowed: boolean) =>
    new Promise<boolean>((resolve) => {
      const made = context();
      const text = sendString(
        send(getClass("NSString"), selector("alloc")),
        selector("initWithUTF8String:"),
        reason,
      );
      replied = (ok) => {
        // After this reply returns, so nothing of LocalAuthentication's is still on the stack.
        setImmediate(() => {
          release(text);
          release(made);
        });
        resolve(ok);
      };
      try {
        if (interactionNotAllowed) sendBool(made, selector("setInteractionNotAllowed:"), 1);
        evaluate(
          made,
          selector("evaluatePolicy:localizedReason:reply:"),
          DEVICE_OWNER,
          text,
          block,
        );
      } catch {
        replied = undefined;
        release(text);
        release(made);
        resolve(false);
      }
    });

  let queue: Promise<unknown> = Promise.resolve();
  return {
    canEvaluate: () => {
      const made = context();
      try {
        return canEvaluate(made, selector("canEvaluatePolicy:error:"), DEVICE_OWNER, [null]) === 1;
      } finally {
        release(made);
      }
    },
    evaluate: (reason, interactionNotAllowed) => {
      const turn = queue.then(() => evaluateOnce(reason, interactionNotAllowed));
      queue = turn;
      return turn;
    },
  };
}
