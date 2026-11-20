/**
 * A minimal protobuf/gRPC-web ENCODER for tests: enough to build the
 * consumer credits config the way the vendor sends it, so the app's reader
 * is exercised on real wire bytes rather than on a hand-written object.
 */

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

export function varint(value: number | bigint): Uint8Array {
  const bytes: number[] = [];
  let remaining = BigInt(value);
  do {
    let byte = Number(remaining & 0x7fn);
    remaining >>= 7n;
    if (remaining > 0n) byte |= 0x80;
    bytes.push(byte);
  } while (remaining > 0n);
  return Uint8Array.from(bytes);
}

export function scalarField(field: number, value: number | bigint): Uint8Array {
  return concatBytes(varint(field << 3), varint(value));
}

export function floatField(field: number, value: number): Uint8Array {
  const bytes = new Uint8Array(5);
  bytes[0] = (field << 3) | 5;
  new DataView(bytes.buffer).setFloat32(1, value, true);
  return bytes;
}

export function messageField(field: number, value: Uint8Array): Uint8Array {
  return concatBytes(varint((field << 3) | 2), varint(value.length), value);
}

/** `google.protobuf.Timestamp` with seconds and (as the vendor sends) nanos. */
export function timestampMessage(epochSeconds: number, nanos = 885_889_000): Uint8Array {
  return concatBytes(scalarField(1, epochSeconds), scalarField(2, nanos));
}

export function grpcFrame(payload: Uint8Array, flags = 0): Uint8Array {
  const frame = new Uint8Array(payload.length + 5);
  frame[0] = flags;
  new DataView(frame.buffer).setUint32(1, payload.length);
  frame.set(payload, 5);
  return frame;
}

export function grpcTrailer(fields: Record<string, string>): Uint8Array {
  const text = `${Object.entries(fields)
    .map(([key, value]) => `${key}:${value}`)
    .join("\r\n")}\r\n`;
  return grpcFrame(new TextEncoder().encode(text), 0x80);
}

export type ConsumerConfigOptions = {
  /** Shared credit usage percent; omit the field with `undefined`. */
  percentUsed?: number;
  products?: Array<{ product?: number; percentUsed?: number }>;
  /** 1 monthly, 2 weekly, 0 unspecified. */
  periodType?: number;
  periodStartSeconds?: number;
  periodEndSeconds?: number;
  prepaidBalance?: number;
};

/**
 * A `GetGrokCreditsConfigResponse` message in the layout observed live on
 * 2026-09-05 (see the parser's header for the field map).
 */
export function consumerConfigMessage(options: ConsumerConfigOptions): Uint8Array {
  const config: Uint8Array[] = [];
  if (options.percentUsed !== undefined) config.push(floatField(1, options.percentUsed));
  for (const product of options.products ?? []) {
    const fields: Uint8Array[] = [];
    if (product.product !== undefined) fields.push(scalarField(1, product.product));
    if (product.percentUsed !== undefined) fields.push(floatField(2, product.percentUsed));
    config.push(messageField(7, concatBytes(...fields)));
  }
  if (options.periodType !== undefined) {
    const period: Uint8Array[] = [scalarField(1, options.periodType)];
    if (options.periodStartSeconds !== undefined) {
      period.push(messageField(2, timestampMessage(options.periodStartSeconds)));
    }
    if (options.periodEndSeconds !== undefined) {
      period.push(messageField(3, timestampMessage(options.periodEndSeconds)));
    }
    config.push(messageField(8, concatBytes(...period)));
  }
  if (options.prepaidBalance !== undefined) {
    config.push(
      messageField(
        12,
        options.prepaidBalance === 0 ? new Uint8Array() : scalarField(1, options.prepaidBalance),
      ),
    );
  }
  return messageField(1, concatBytes(...config));
}

/** A complete successful gRPC-web body: one data frame plus an OK trailer. */
export function grpcWebOkBody(message: Uint8Array): Uint8Array {
  return concatBytes(grpcFrame(message), grpcTrailer({ "grpc-status": "0" }));
}
