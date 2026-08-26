import type { FileRow, Remediation } from "@kaname/contract";
import { ApiError, buildPath, redirectToLogin, type AnyErrorCode } from "@/lib/api";

/* ------------------------------------------------------------------ *
 * Upload transport.
 *
 * `POST /files/upload` is one of the two file routes that is not a job:
 * the body only exists for the life of the request, so there is nothing
 * a queued row could hold. That also means the operator gets real byte
 * progress instead of a job pill — which is the honest trade, because
 * here the panel genuinely does know how far along the work is.
 *
 * XMLHttpRequest rather than fetch, for exactly one reason: fetch has no
 * upload progress event, and a 400 MB tarball crawling up a home DSL
 * line with no indication of progress is indistinguishable from a hang.
 * ------------------------------------------------------------------ */

interface ErrorEnvelope {
  error?: {
    code?: string;
    message?: string;
    remediation?: Remediation;
    fields?: Record<string, string>;
    request_id?: string;
  };
}

export interface UploadOptions {
  serverId: string;
  /** Destination directory; the filename comes from the part. */
  directory: string;
  file: File;
  overwrite: boolean;
  onProgress: (loaded: number, total: number) => void;
}

export interface UploadHandle {
  done: Promise<FileRow>;
  cancel: () => void;
}

export function uploadFile(options: UploadOptions): UploadHandle {
  const { serverId, directory, file, overwrite, onProgress } = options;
  const xhr = new XMLHttpRequest();

  const done = new Promise<FileRow>((resolve, reject) => {
    xhr.open(
      "POST",
      buildPath("/files/upload", {
        server_id: serverId,
        path: directory,
        // The agent has no end-of-body marker on the frame envelope, so
        // the declared size is how it knows the file is complete.
        size: file.size,
        // Omitted rather than sent false: the query schema coerces, and
        // "false" would coerce to true and clobber an existing file.
        overwrite: overwrite ? true : undefined,
      }),
      true,
    );
    xhr.responseType = "text";
    xhr.setRequestHeader("Accept", "application/json");

    xhr.upload.addEventListener("progress", (event) => {
      onProgress(event.loaded, event.lengthComputable ? event.total : file.size);
    });

    xhr.addEventListener("load", () => {
      const text = typeof xhr.response === "string" ? xhr.response : "";
      let payload: unknown = null;
      try {
        payload = text.length > 0 ? JSON.parse(text) : null;
      } catch {
        /* Handled below: a non-JSON body from an ok status is malformed. */
      }

      if (xhr.status >= 200 && xhr.status < 300) {
        const row = (payload as { data?: FileRow } | null)?.data;
        if (row) {
          resolve(row);
          return;
        }
        reject(
          new ApiError({
            code: "malformed_response",
            message: "The upload finished but the control plane did not describe the file.",
            status: xhr.status,
          }),
        );
        return;
      }

      if (xhr.status === 401) redirectToLogin();

      const envelope = ((payload ?? {}) as ErrorEnvelope).error ?? {};
      reject(
        new ApiError({
          code: (envelope.code as AnyErrorCode) ?? "internal_error",
          message: envelope.message ?? `The upload was refused (${xhr.status}).`,
          status: xhr.status,
          remediation: envelope.remediation ?? null,
          fields: envelope.fields ?? {},
          requestId: envelope.request_id ?? null,
        }),
      );
    });

    xhr.addEventListener("error", () => {
      reject(
        new ApiError({
          code: "network_error",
          message: `${file.name} did not reach the control plane.`,
          status: 0,
          remediation: {
            summary:
              "The connection dropped mid-transfer, so nothing was written on the host. Retry the upload.",
            actions: [],
          },
        }),
      );
    });

    xhr.addEventListener("abort", () => {
      reject(new ApiError({ code: "aborted", message: "Upload cancelled.", status: 0 }));
    });

    const form = new FormData();
    form.append("file", file, file.name);
    xhr.send(form);
  });

  return { done, cancel: () => xhr.abort() };
}
