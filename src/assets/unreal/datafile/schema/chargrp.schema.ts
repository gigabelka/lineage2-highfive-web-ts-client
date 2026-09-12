/* system/chargrp.dat: no row count in the file, L2FileEdit's C4 chargrp.ddf RECCNT.
   The row layout itself doesn't fit this project's declarative ISchemaValue[] model - see
   ../chargrp-reader.ts, which decodes it with a bespoke scanning reader instead. This constant
   is the only piece of the ddf schema that still holds. */
const CHARGRP_RECORD_COUNT = 15;

export { CHARGRP_RECORD_COUNT };
