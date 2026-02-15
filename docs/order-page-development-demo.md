# 주문 페이지 개발 데모 시나리오

이 문서는 사용자가 `주문 페이지 개발` 요청을 했을 때 AAO가 `aao init`과 `aao manager feature "주문 페이지 개발"` 실행 흐름에서 실제로 어떻게 동작하는지 보여준다.

## 0. 워크스페이스 준비

```bash
aao init
```

- 실행 결과: 현재 디렉터리에 `ai-dev-team/` 생성
- 생성 항목: `ai-dev-team/config/workflows/feature.yaml` 포함
- 역할/Provider 매핑은 `config/routing.yaml` 참고
- 이 단계에서는 provider 실행이 발생하지 않음

## 1) feature workflow 실행

```bash
aao manager feature "주문 페이지 개발"
```

- 워크플로우 파일: `ai-dev-team/config/workflows/feature.yaml`
- run 루트: `.runs/workflows/<run-id>/`
- 기본 순서:

```text
plan -> manager_report_plan -> approve -> implement -> evaluate -> manager_report_result -> review
```

## 단계별 실행 상세

### 1-1) plan
- 역할/Provider: `planner` / `codex-cli`
- 동작: 주문 페이지 개발 요청을 계획으로 변환
- 핵심 산출물:
  - `artifacts/plan/iter-0001.raw.txt`
  - `artifacts/plan/iter-0001.plan.md`

### 1-2) manager_report_plan
- 역할/Provider: `manager` / `gemini-cli`
- 동작: plan 결과를 사용자 승인용 메시지 형식(`USER_UPDATE`)으로 변환
- 핵심 산출물:
  - `artifacts/manager_report_plan/iter-0001.raw.txt`
  - `artifacts/manager_report_plan/iter-0001.manager-update.md`

### 1-3) approve
- 역할/Provider: 없음(사용자 승인 단계)
- 사용자 승인 요청 시점: **`manager_report_plan` 직후 즉시 표시**
- 산출물:
  - `artifacts/approve/iter-0001.approval.txt`
- 응답에 따른 분기:
  - 승인 → `implement`
  - 거절 → run 종료(`canceled`)

### 1-4) implement
- 역할/Provider: `developer` / `claude-cli`
- 동작: patch-first 방식으로 코드 변경 제안 및 적용
- 핵심 산출물:
  - `artifacts/implement/iter-0001.raw.txt`
  - `artifacts/implement/iter-0001.patch`
  - `artifacts/implement/iter-0001.diff.txt`
  - `artifacts/implement/iter-0001.diffstat.txt`
- 추가 산출물(조건부):
  - 위험 변경 감지 시 `artifacts/implement/iter-0001.gatekeeper-risk.json`
  - 승인 필요 시 `artifacts/implement/iter-0001.gatekeeper-approval.txt`
- 사용자 승인 요청 시점(조건부): **변경 위험이 큼으로 판정될 때** Gatekeeper에서 추가 승인

### 1-5) evaluate
- 역할/Provider: `evaluator` / `codex-cli`
- 동작: 구현 결과를 기준으로 `DECISION: PASS|FIX|ASK` 판정
- 핵심 산출물:
  - `artifacts/evaluate/iter-0001.raw.txt`
- 다음 전이:
  - `PASS`, `FIX`, `ASK` 모두 `manager_report_result`로 이동(템플릿 규칙)

### 1-6) manager_report_result
- 역할/Provider: `manager` / `gemini-cli`
- 동작: 구현/평가 결과를 사용자 메시지 형식으로 정리
- 핵심 산출물:
  - `artifacts/manager_report_result/iter-0001.raw.txt`
  - `artifacts/manager_report_result/iter-0001.manager-update.md`

### 1-7) review
- 역할/Provider: `reviewer` / `gemini-cli`
- 동작: 최종 리뷰 요약 생성
- 핵심 산출물:
  - `artifacts/review/iter-0001.raw.txt`

## 실행 후 확인 포인트

- run 요약: `summary.md`
- 상태/phase: `current-run.json`
- run 출력에는 manager 메시지가 `# USER_UPDATE` 형식으로 표시됨
- 폴더 구조 예시:

```text
.runs/workflows/<run-id>/
├─ current-run.json
├─ summary.md
└─ artifacts/
   ├─ plan/
   ├─ manager_report_plan/
   ├─ approve/
   ├─ implement/
   ├─ evaluate/
   ├─ manager_report_result/
   └─ review/
```
