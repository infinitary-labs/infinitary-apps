import type { CoreDispatch } from "@core/index";
import {
  type CoreInvokeChannel,
  type InvokeChannel,
  type InvokeRequest,
  type InvokeResponse,
  parseInvokeRequest,
} from "@shared/ipc";
import type { IpcMainInvokeEvent } from "electron";
import { ipcMain } from "electron";
import { isAppRendererSource, type RendererSourceOptions } from "../security/rendererSource";

/**
 * IPC discipline (docs/architecture.md section 4): every invoke channel
 * validates the sender frame is our own renderer document and zod-parses the
 * request args before the handler runs. Handlers get typed, validated input.
 */
export function handleInvoke<C extends InvokeChannel>(
  channel: C,
  options: RendererSourceOptions,
  handler: (
    event: IpcMainInvokeEvent,
    ...args: InvokeRequest<C>
  ) => Promise<InvokeResponse<C>> | InvokeResponse<C>,
): void {
  ipcMain.handle(channel, async (event, ...rawArgs) => {
    if (!isAppRendererSource(event.senderFrame?.url, options)) {
      throw new Error(`Rejected ${channel}: unrecognized sender frame`);
    }
    return handler(event, ...parseInvokeRequest(channel, rawArgs));
  });
}

/**
 * A core-surface channel: Electron IPC carries it, the core answers it. The
 * transport's own job is the sender-frame check; the args stay raw because
 * the dispatcher validates them for whichever transport delivered them.
 */
export function forwardInvoke<C extends CoreInvokeChannel>(
  channel: C,
  options: RendererSourceOptions,
  dispatch: CoreDispatch,
): void {
  ipcMain.handle(channel, async (event, ...rawArgs) => {
    if (!isAppRendererSource(event.senderFrame?.url, options)) {
      throw new Error(`Rejected ${channel}: unrecognized sender frame`);
    }
    return dispatch(channel, rawArgs);
  });
}
