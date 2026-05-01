---
"@wrightful/reporter": patch
---

Add `default` export condition so Playwright's CJS-based reporter resolver can locate the package. Previously, `require.resolve("@wrightful/reporter")` failed with `ERR_PACKAGE_PATH_NOT_EXPORTED` because the exports map only declared `types` + `import` conditions.
