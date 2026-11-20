---
name: rtk
description: Use RTK to reduce terminal output and save context tokens.
---

When executing supported terminal commands, prefer RTK:

- git status → rtk git status
- git diff → rtk git diff
- git log → rtk git log
- npm test → rtk npm test
- pnpm test → rtk pnpm test
- ripgrep → rtk rg

Use `rtk bypass` when full unfiltered output is required.
Never omit error details or test failures.
