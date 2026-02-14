# @adt/tui

Phase 08 최소 TUI 런너.

## 실행

```bash
pnpm --filter @adt/tui build
node packages/tui/dist/index.js "리팩터링 요청"
```

또는 strip-types로 소스 직접 실행:

```bash
node --experimental-strip-types packages/tui/src/index.ts "리팩터링 요청"
```

## 화면 구성

- 현재 run 상태: `phase`, `retries`, `last error`
- artifacts 목록 (최근 항목)
- 승인 요청: `1) 승인`, `2) 거절`, `3) 프롬프트 토글`
