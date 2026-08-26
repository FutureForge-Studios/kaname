import { archiveFormat } from "../enums.js";

export { absolutePath, identifier, ipAddress, cidr, fileMode } from "../primitives.js";

/** Archives default to tar.gz because every managed host can read one. */
export const archiveFormatOrDefault = archiveFormat.default("tar.gz");
