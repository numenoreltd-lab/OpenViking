이 맥의 OpenViking 메모리 플러그인(Codex, Claude Code)을 우리 포크의 최신 판으로 맞춰 줘.
이미 포크로 바꾼 맥이어도 아래를 그대로 실행하면 새 판으로 갱신된다.

## 배경

- Codex·Claude Code의 OpenViking 플러그인은 대화 기록 파일을 통째로 읽는다. 파일이 512MB를 넘으면
  `Invalid string length`로 실패하고, 그 세션은 더 이상 기억으로 저장되지 않는다. Codex에서는 문맥 압축 때마다
  `pre-compact transcript unreadable …`이 뜬다. Claude Code는 같은 실패를 조용히 넘긴다.
- 한 줄씩 읽어도 매번 처음부터 읽으면 Codex 세션이 약 2.5GB를 넘을 때 메모리가 모자라 훅이 기록도 없이
  죽는다. 고친 판은 지난번 읽은 턴 경계부터만 읽는다(저장 상태의 `transcriptCursor`).
- 고친 판이 `numenoreltd-lab/OpenViking` 포크의 `numenore` 브랜치에 있다. 원본에는 PR로 낼 예정이다.
- 그동안 실패해 밀린 기록은 최근 1,000턴만 보낸다(`use-fork.sh`가 `~/.openviking/ovcli.conf`에
  `plugin.captureCatchUpMaxTurns = 1000`을 넣는다). 이 값을 바꾸지 마.
- 플러그인 파일을 손으로 고치지 마. Codex는 수시로 플러그인을 다시 받아서 손으로 고친 것을 지운다.
  출처를 포크로 바꾸는 것이 해결이다.

## 할 일

1. 먼저 지금 상태를 기록해. 아래를 실행하고 결과를 그대로 남겨.

       d=$(mktemp -d) && git clone -q --depth 1 --filter=blob:none --sparse -b numenore \
         https://github.com/numenoreltd-lab/OpenViking.git "$d" && git -C "$d" sparse-checkout set numenore \
         && bash "$d/numenore/use-fork.sh" --check

   `codex:`·`claude:` 줄이 `not-installed`면 그 플러그인은 이 맥에 없는 것이다. 설치는 하지 말고 그대로 보고해.

2. 같은 폴더에서 바꾼다.

       bash "$d/numenore/use-fork.sh"

3. 확인한다. 아래 세 가지를 실행하고 결과를 남겨.

       bash "$d/numenore/use-fork.sh" --check
       git -C ~/.codex/.tmp/marketplaces/openviking log -1 --format='%h %s'
       grep -c readTurnsFromCursor ~/.codex/plugins/cache/openviking/openviking-memory/*/scripts/ov-session.mjs

   - `codex:`·`claude:` 줄이 `https://github.com/numenoreltd-lab/OpenViking.git @ numenore`
   - `apply.sh` 결과가 버전마다 `already patched`, `fix already shipped upstream`,
     `not the installed version, skipped`(쓰지 않는 예전 캐시) 중 하나
   - 위 `grep` 결과가 1 이상
   - Codex 마켓플레이스 커밋 제목이 `chore(numenore): fork tooling on … (resume from cursor)`
   - 출력에 `ovcli.conf: plugin.captureCatchUpMaxTurns = 1000`

4. 이 맥에서 512MB가 넘는 대화 기록이 있는지 세어서 남겨. 있으면 이번 수정이 실제로 필요한 맥이다.

       find ~/.codex/sessions -name 'rollout-*.jsonl' -size +512M | wc -l
       find ~/.claude/projects -name '*.jsonl' -size +512M | wc -l

## 지킬 것

- 실패하면 고치려 들지 말고 멈춘 뒤, 실행한 명령과 출력을 그대로 보고해.
- 2GB가 넘는 대화 기록이 있으면 따로 알려 줘. 그 세션의 첫 저장은 처음부터 읽느라 수십 초 걸린다(그다음부터는 바로 끝난다).
- `apply.sh`가 `earlier patch replaced`를 찍으면 예전 판 패치를 새 판으로 바꾼 것이다. 정상이다.
- 훅은 실행될 때마다 새로 뜨므로, 플러그인 버전 번호가 그대로면 열린 세션도 다음 훅부터 새 코드를 쓴다.
  `use-fork.sh`가 Claude Code 플러그인 버전을 올렸다면 열린 세션은 재시작해야 한다. 재시작은 사람에게 맡기고 안내만 해.
- 끝나면 맥 이름, 바꾸기 전·후 `--check` 결과, 4번 숫자를 한 번에 보고해.
