# ai-agent-orchestrator Vision

## 한 줄 목표
아티팩트(문서/패치/로그) 중심으로 AI 개발 워크플로를 오케스트레이션하여, 재현 가능하고 안전한 자동 개발 루프를 CLI/TUI에서 제공한다.

## 문제 정의
- LLM 기반 개발 자동화는 출력 형식이 불안정해 재시도/복구가 어렵다.
- 실행 이력과 결정 근거가 남지 않아 팀 단위 운영이 어렵다.
- 툴 실행 권한이 과도하면 로컬 환경 안전성이 떨어진다.

## 핵심 유스케이스 (최대 3개)
1. 단일 작업 자동 루프
한 번의 `run`으로 `Plan -> Execute -> Evaluate -> Fix/Ask`를 반복하고, 결과를 patch/artifact로 남긴다.

2. 중단 후 재개
실패/승인 대기 상태에서 중단된 런을 상태 파일 기반으로 `resume`하여 같은 맥락에서 계속 실행한다.

3. Provider 교체 실험
동일한 워크플로 계약 하에서 Provider(Codex CLI 등)를 바꿔 성능/비용/안정성을 비교한다.

## 비목표 (Phase 00 기준)
- IDE 플러그인, 웹 대시보드 같은 UI 확장
- 원격 실행 인프라/분산 스케줄링
- 범용 CI/CD 파이프라인 대체

## 설계 철학
- Artifact-driven
모든 단계 결과는 읽을 수 있는 아티팩트로 남아야 하며, 상태 복구는 아티팩트와 상태 파일만으로 가능해야 한다.

- Patch-first
기본 출력은 파일 전체 재생성이 아니라 unified diff patch이며, 적용/검증/거절 흐름을 표준화한다.

- Safety-first
Tool Runtime은 allowlist 기반으로 통제하고, 위험 작업은 Gatekeeper 승인 없이는 실행하지 않는다.

- Interface-first
Provider/Workflow/Tool Runtime은 인터페이스 계약을 먼저 고정해 구현 교체가 가능해야 한다.

## 범위 경계
- 이 저장소는 "오케스트레이터 본체"를 다룬다.
- 실제 비즈니스 코드 생성 품질은 Provider 성능에 의존하지만, 오케스트레이터는 출력 파싱/적용/평가/복구 책임을 가진다.

