/**
 * Raw envelope shape returned by signal-cli-rest-api json-rpc mode.
 * All fields are optional-tolerant — the API omits many of them depending
 * on message type (receipts, typing indicators, reactions, etc.).
 */
export interface RawEnvelope {
  sourceUuid?: string;
  sourceNumber?: string;
  sourceDevice?: number;
  timestamp?: number;
  serverGuid?: string;
  dataMessage?: {
    message?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/**
 * One item in the array returned by GET /v1/receive/{botNumber}.
 */
export interface RawReceiveItem {
  envelope: RawEnvelope;
  account?: string;
  [key: string]: unknown;
}

/**
 * Normalised incoming message — only fields we act on.
 * All optional; callers must handle absence.
 */
export interface IncomingMessage {
  /** ACI (account identifier) UUID of the sender */
  sourceUuid?: string;
  /** Sub-device number (usually 1 for the primary device) */
  sourceDevice?: number;
  /** Client-side send timestamp in milliseconds */
  timestamp?: number;
  /** Server-assigned GUID (absent on some server versions) */
  serverGuid?: string;
  /** Decoded plaintext message body */
  body?: string;
}

/**
 * One entry from GET /v1/identities/{botNumber}.
 */
export interface IdentityEntry {
  number: string;
  uuid?: string;
  [key: string]: unknown;
}
