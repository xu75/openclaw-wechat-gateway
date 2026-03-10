# PACKAGE B Integration Notes

## 1) Required change in forbidden file

- File: `package.json`
- Why: `src/content-pipeline/**` now uses Unified/Remark/Rehype toolchain and needs runtime deps to build and run.
- Suggested patch:

```diff
diff --git a/package.json b/package.json
--- a/package.json
+++ b/package.json
@@ -17,7 +17,16 @@
   "dependencies": {
     "better-sqlite3": "^11.8.1",
     "dotenv": "^16.4.5",
     "express": "^4.21.2",
+    "hast-util-sanitize": "^5.0.2",
+    "rehype-parse": "^9.0.1",
+    "rehype-sanitize": "^6.0.0",
+    "rehype-stringify": "^10.0.1",
+    "remark-gfm": "^4.0.1",
+    "remark-parse": "^11.0.0",
+    "remark-rehype": "^11.1.2",
+    "unified": "^11.0.5",
+    "unist-util-visit": "^5.0.0",
     "zod": "^3.24.2"
   },
 ```

## 2) Optional integration change

- File: `package.json`
- Why: run PACKAGE B unit tests quickly in CI/local.
- Suggested patch:

```diff
diff --git a/package.json b/package.json
--- a/package.json
+++ b/package.json
@@ -10,7 +10,8 @@
     "build": "tsc -p tsconfig.json",
     "start:prod": "node dist/app/server.js",
     "check": "tsc --noEmit",
-    "db:migrate": "tsx src/repo/sqlite/migrations.ts"
+    "db:migrate": "tsx src/repo/sqlite/migrations.ts",
+    "test:content-pipeline": "tsx --test src/content-pipeline/**/*.test.ts"
   },
 ```
