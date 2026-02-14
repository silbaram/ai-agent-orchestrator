# ai-agent-orchestrator Contracts

## 1) 문서 목적
이 문서는 오케스트레이터 구현 전 고정해야 하는 출력/상태/인터페이스 계약을 정의한다.  
구현체는 언어와 무관하게 아래 계약을 만족해야 한다.

## 2) 공통 규칙
- 모든 시간 값은 UTC ISO-8601 문자열을 사용한다. (예: `2026-02-14T12:34:56Z`)
- 모든 식별자는 런 범위에서 유일해야 한다.
- 필수 필드는 누락할 수 없다.
- 계약 용어:
  - MUST: 반드시 지켜야 함
  - SHOULD: 특별한 이유가 없으면 지켜야 함
  - MAY: 선택 사항

---

## 3) Provider 계약

### 3.1 Provider 역할
Provider는 모델 호출을 담당하며, 워크플로 제어/파일 수정/패치 적용은 하지 않는다.  
즉, Provider는 `입력 -> 모델 출력` 변환 책임만 가진다.

### 3.2 Provider 인터페이스 (논리 계약)
```ts
type WorkflowPhase = "plan" | "execute" | "evaluate" | "fix" | "ask";
type AgentRole = "planner" | "developer" | "evaluator" | "fixer";

interface ProviderRequest {
  runId: string;
  iteration: number;
  phase: WorkflowPhase;
  role: AgentRole;
  prompt: {
    system: string;
    user: string;
  };
  contextArtifacts: Array<{
    name: string;
    path: string;
    content: string;
  }>;
  constraints: {
    timeoutMs: number;
    maxOutputTokens?: number;
    temperature?: number;
    patchFirst: boolean; // developer/fixer는 true MUST
  };
}

interface ProviderResponse {
  rawText: string;              // 모델 원문 출력 MUST
  finishReason: "stop" | "length" | "timeout" | "error";
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
  durationMs: number;
  error?: {
    code: "TIMEOUT" | "RATE_LIMIT" | "AUTH" | "BAD_REQUEST" | "UNKNOWN";
    message: string;
    retriable: boolean;
  };
}
```

### 3.3 Provider capabilities 계약
```ts
interface ProviderCapabilities {
  name: string;
  version?: string;
  supportsPatchFirst: boolean; // true SHOULD
  supportsStreaming?: boolean;
  supportsToolCalls?: boolean;
  maxContextTokens?: number;
}
```

### 3.4 동작 제약
- Provider는 파일시스템 변경을 직접 수행하면 안 된다.
- Provider 응답 원문(`rawText`)은 반드시 아티팩트로 저장해야 한다.
- 타임아웃/에러 발생 시 `error`를 채워 상위 오케스트레이터가 재시도 정책을 적용할 수 있어야 한다.

---

## 4) Workflow 상태/이벤트 계약

### 4.1 상태 모델
```ts
type RunStatus =
  | "created"
  | "running"
  | "awaiting_approval"
  | "awaiting_input"
  | "completed"
  | "failed"
  | "canceled";

interface WorkflowState {
  runId: string;
  status: RunStatus;
  currentPhase: WorkflowPhase | null;
  iteration: number; // fix 재시도 포함 누적
  maxFixIterations: number; // 기본 3
  lastEventId: string | null;
  pendingApprovalId?: string;
  pendingQuestionId?: string;
  createdAt: string;
  updatedAt: string;
  lastError?: {
    code: string;
    message: string;
  };
}
```

### 4.2 이벤트 타입
```ts
type WorkflowEventType =
  | "RUN_CREATED"
  | "PHASE_STARTED"
  | "PHASE_COMPLETED"
  | "PHASE_FAILED"
  | "PATCH_PRODUCED"
  | "APPROVAL_REQUESTED"
  | "APPROVAL_GRANTED"
  | "APPROVAL_REJECTED"
  | "PATCH_APPLIED"
  | "PATCH_APPLY_FAILED"
  | "EVALUATION_PASSED"
  | "EVALUATION_FAILED_FIXABLE"
  | "EVALUATION_FAILED_BLOCKED"
  | "QUESTION_RAISED"
  | "QUESTION_ANSWERED"
  | "RUN_COMPLETED"
  | "RUN_FAILED"
  | "RUN_CANCELED";

interface WorkflowEvent<T = Record<string, unknown>> {
  id: string;
  runId: string;
  ts: string;
  type: WorkflowEventType;
  phase?: WorkflowPhase;
  iteration?: number;
  payload: T;
}
```

### 4.3 표준 전이
`Plan -> Execute -> Evaluate -> (Completed | Fix | Ask)`가 기본 루프다.

1. `RUN_CREATED` 후 `plan` 시작
2. `plan` 완료 시 `execute` 시작
3. `execute` 결과:
   - patch 생성: `PATCH_PRODUCED` -> (승인 필요 시) `APPROVAL_REQUESTED`
   - 질문 필요: `QUESTION_RAISED` -> `awaiting_input`
4. patch 승인 후 적용: `PATCH_APPLIED` -> `evaluate`
5. `evaluate` 결과:
   - 통과: `EVALUATION_PASSED` -> `RUN_COMPLETED`
   - 수정 가능 실패: `EVALUATION_FAILED_FIXABLE` -> `fix`
   - 차단 실패(정보 부족/요구 불명확): `EVALUATION_FAILED_BLOCKED` -> `ask`
6. `fix`는 `execute`와 동일 계약으로 patch 또는 ask를 출력한다.
7. fix 반복이 `maxFixIterations`를 초과하면 `RUN_FAILED`로 종료한다.

### 4.4 승인(Gatekeeper) 계약
- `APPROVAL_REQUESTED` 상태에서는 패치를 적용하면 안 된다.
- 승인 결과는 반드시 이벤트로 기록한다.
- 승인 거절 시:
  - 재수정 가능하면 `fix`로 이동
  - 정책상 종료면 `RUN_CANCELED` 또는 `RUN_FAILED`

---

## 5) Developer/Fixer 출력 계약 (Patch-first 기본)

### 5.1 결과 타입
Developer/Fixer 응답은 아래 3개 중 정확히 하나여야 한다.
- `PATCH` (기본, MUST)
- `ASK` (정보 부족/위험 판단 시)
- `NOOP` (이미 목표 충족 시, 드물게 사용)

### 5.2 PATCH 포맷 (정규형)
```text
<<<AIO_RESULT_START>>>
type: PATCH
summary: 변경 요약 한 줄
<<<AIO_RESULT_END>>>

[PATCH_BEGIN]
diff --git a/path/to/file b/path/to/file
index 1111111..2222222 100644
--- a/path/to/file
+++ b/path/to/file
@@ -1,1 +1,2 @@
-old
+new
[PATCH_END]

<<<AIO_CHECKS_START>>>
- command: pnpm -w test
  status: pass|fail|not_run
  exitCode: 0
<<<AIO_CHECKS_END>>>
```

PATCH 타입 추가 규칙:
- unified diff MUST (`diff --git` 헤더 포함)
- 상대 경로 MUST
- 바이너리 패치/압축 데이터 금지
- patch 외 대량 설명보다 적용 가능한 diff를 우선

### 5.3 ASK 포맷
```text
<<<AIO_RESULT_START>>>
type: ASK
question: 사용자의 결정이 필요한 질문 1개
reason: 왜 막혔는지
needed_input:
- 값 A
- 값 B
<<<AIO_RESULT_END>>>
```

ASK 타입 규칙:
- 질문은 실행 가능하게 구체적이어야 한다.
- 질문 없이 "진행 불가"만 출력하면 계약 위반이다.

### 5.4 NOOP 포맷
```text
<<<AIO_RESULT_START>>>
type: NOOP
reason: 이미 목표 상태임
<<<AIO_RESULT_END>>>
```

### 5.5 파서 fallback 규칙
- 정규형 마커가 없더라도 `diff` 코드블록이 있으면 PATCH 후보로 파싱 MAY.
- 어떤 타입으로도 파싱 불가하면 `PHASE_FAILED` 처리 후 fix 재시도 또는 ask로 전환한다.

---

## 6) Artifact / State / Log 기록 계약

### 6.1 런 디렉토리 구조
```text
.runs/workflows/<runId>/
  state.json
  events.ndjson
  artifacts/
    plan/
      iter-0001.md
    execute/
      iter-0001.raw.txt
      iter-0001.patch
    evaluate/
      iter-0001.json
    fix/
      iter-0002.raw.txt
      iter-0002.patch
    ask/
      iter-0002.md
  logs/
    provider-plan.log
    provider-execute.log
    gatekeeper.log
```

### 6.2 기록 규칙
- `state.json`은 최신 상태 스냅샷 1개를 유지한다.
- `events.ndjson`은 append-only다.
- Provider 원문 응답(`*.raw.txt`)은 항상 저장한다.
- 패치 적용 전/후 diffstat는 이벤트 payload 또는 evaluate artifact에 남긴다.
- 오류 발생 시 stack/error payload를 로그와 이벤트 양쪽에 남긴다.

### 6.3 최소 복구 조건
아래 3개가 있으면 런 재개(resume)가 가능해야 한다.
1. `state.json`
2. `events.ndjson`
3. 마지막 phase의 raw output artifact

---

## 7) 구현 체크리스트
- Provider adapter가 `ProviderRequest/Response` 계약을 만족하는가
- 상태 전이가 4.3 표준 전이를 벗어나지 않는가
- Developer/Fixer 출력에서 PATCH/ASK/NOOP를 안정적으로 파싱하는가
- 모든 런에서 state/events/artifacts/logs가 남는가
