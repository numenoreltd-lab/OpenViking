# numenoreltd-lab/OpenViking 포크 — 운영 안내

이 포크는 원본(volcengine/OpenViking)이 아직 반영하지 않은 수정을 우리 맥들에 배포하려고 둔다.
원본에 반영되면 이 포크는 더 쓸 일이 없다.

| 브랜치 | 내용 |
|---|---|
| `main` | 원본 main 그대로 |
| `fix/stream-large-transcripts` | 원본 main + 수정 한 커밋. 원본에 내는 PR 브랜치 |
| `numenore` | 위 + 이 `numenore/` 폴더. **각 맥의 플러그인은 이 브랜치에서 받는다** |

## 들어 있는 수정

Codex·Claude Code 메모리 플러그인이 대화 기록을 통째로 읽어, 512MB를 넘으면 `Invalid string length`로
그 세션의 기억 저장이 멈추던 문제. Codex에서는 문맥 압축 때마다 `pre-compact transcript unreadable`이
뜬다. 파일을 한 줄씩 읽도록 고쳤다. 자세한 근거는 `fix/stream-large-transcripts` 커밋 메시지.

지난번 위치부터 읽기: 한 줄씩 읽어도 매번 처음부터 끝까지 읽으면, Codex 세션이 약 2.5GB를 넘을 때
Node 메모리 한도를 넘어 훅이 기록도 남기지 못하고 죽는다. 이제 턴 경계(Codex `turn_context`,
Claude Code 사용자 프롬프트)마다 끊어 한 턴씩 처리하고, 마지막 턴 경계의 바이트 위치를 저장 상태
(`transcriptCursor`)에 남겨 다음에는 거기서부터 읽는다. 2.6GB Codex 세션: 처음 32초·힙 52MB,
그다음부터 0.002초. 저장 위치가 없거나 파일이 바뀌어 맞지 않으면 처음부터 다시 읽는다(메모리는 그대로 적다).

밀린 기록 상한: 그동안 저장에 실패해 밀린 턴이 많으면 한 번에 전부 보내지 않고 최근 1,000턴만 보낸다
(`captureCatchUpMaxTurns`, `use-fork.sh`가 `~/.openviking/ovcli.conf`의 `plugin`에 1000으로 넣는다).
건너뛴 수는 훅 로그에 `catch_up_capped`로 남는다.

달라지는 점: 예전에는 파일 전체에서 같은 호출 id의 도구 출력이 두 번째부터 버려졌다. 이제는 턴 안에서만
걸러서, 오래 도는 명령의 출력이 다음 턴에도 기록되면 그 턴의 것으로 한 번 더 들어간다(이 맥 1,425개 중
1개 세션, 2턴).

## 맥 하나를 포크로 바꾸기

    d=$(mktemp -d) && git clone -q --depth 1 --filter=blob:none --sparse -b numenore \
      https://github.com/numenoreltd-lab/OpenViking.git "$d" && git -C "$d" sparse-checkout set numenore \
      && bash "$d/numenore/use-fork.sh"

- Codex: `~/.codex/config.toml`의 `[marketplaces.openviking]` 출처를 포크 `numenore`로 바꾸고 다시 받는다.
  Codex는 출처 커밋이 바뀌면 같은 버전이라도 다시 받으므로, 이후 수정은 저절로 따라온다
- Claude Code: `~/.openviking/marketplaces/openviking-claude`의 출처를 바꾼다. Claude Code는 **버전이 바뀔 때만**
  다시 받기 때문에, 지금 깔린 버전은 `apply.sh`가 제자리에서 고친다. 다음 버전부터는 포크에서 받는다
- 바꾸기 전 설정은 `.bak-<시각>` 으로 남는다
- 상태만 보기: `bash use-fork.sh --check` · 원본으로 되돌리기: `bash use-fork.sh --upstream`
- 플러그인이 아직 없는 맥은 원본 설치 프로그램으로 먼저 설치한 뒤 실행한다

## 포크를 원본에 맞추기 (관리자)

    bash numenore/sync-fork.sh --dry-run   # 받아서 테스트만
    bash numenore/sync-fork.sh             # 테스트 통과하면 세 브랜치를 올림

원본 main을 받아 수정 커밋을 다시 얹고, 플러그인 테스트가 통과할 때만 올린다. 원본이 수정을 받아들이면
수정 커밋이 비게 되고, 그때 각 맥에서 `use-fork.sh --upstream`으로 되돌린다.

## 파일

| 파일 | 내용 |
|---|---|
| `use-fork.sh` | 맥의 플러그인 출처를 포크/원본으로 바꿈 |
| `apply.sh` + `*.patch` | 이미 깔린 버전을 제자리에서 고침 (Claude Code 같은 버전 대응) |
| `previous/*.patch` | 예전 판 패치. `apply.sh`가 이것이 깔린 곳을 찾아 새 패치로 바꾼다 |
| `sync-fork.sh` | 포크를 원본 최신에 맞춤 |
| `WORKER-PROMPT.md` | 다른 맥의 Claude에게 붙여 넣을 작업 지시 |
