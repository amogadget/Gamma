// Compatibility entry point; all brand outputs share one generator.
'use strict';
import('../../tools/branding/build.mjs').catch(error => { console.error(error); process.exitCode = 1; });
