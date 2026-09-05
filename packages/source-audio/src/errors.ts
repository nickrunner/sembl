/**
 * Why turning audio into a source failed, in terms a caller can act on.
 *
 * `"api"` is the transcription service failing — worth a retry when
 * `retryable`. `"unsupported"` is the recording itself: a container the
 * service cannot decode, or bytes that are not audio at all. `"too_long"`
 * is a limit — the caller's `maxDurationSec`, or the service's own size cap.
 * Neither of the last two changes on a retry.
 */
export type AudioSourceErrorKind = "api" | "unsupported" | "too_long";

/**
 * Error thrown by everything in `@sembl/source-audio`.
 *
 * Branch on `kind` rather than matching the message — messages stay
 * diagnostic and are free to change.
 */
export class AudioSourceError extends Error {
  /** What class of failure this is. */
  public readonly kind: AudioSourceErrorKind;
  /**
   * Whether another attempt could plausibly succeed. Only an `"api"`
   * failure that was transient in nature — a rate limit, an outage, a
   * dropped connection — is retryable.
   */
  public readonly retryable: boolean;
  /** HTTP status, when the failure came back from a service. */
  public readonly status?: number;

  constructor(
    message: string,
    options: { kind: AudioSourceErrorKind; retryable?: boolean; status?: number; cause?: unknown },
  ) {
    super(message, { cause: options.cause });
    this.name = "AudioSourceError";
    this.kind = options.kind;
    this.retryable = options.retryable ?? false;
    this.status = options.status;
  }
}
