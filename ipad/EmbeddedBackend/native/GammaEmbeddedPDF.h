#pragma once
#ifndef PY_SSIZE_T_CLEAN
#define PY_SSIZE_T_CLEAN
#endif
#include <Python.h>

/* Compile GammaEmbeddedPDF.m with ARC, link Foundation, PDFKit and CoreGraphics.
 * Before Py_Initialize: PyImport_AppendInittab("_gamma_ios_pdf", PyInit__gamma_ios_pdf).
 * No Swift app-module import is required. This header does not register itself.
 * Built-in CPython module; not a pypdfium2 replacement or a PDF writer.
 */
PyMODINIT_FUNC PyInit__gamma_ios_pdf(void);
