---
source: d1435fbb25dfd2af
title: 작업과 선원
description: 작업이 무엇인지, 백로그에서 완료까지 어떻게 진행되는지, 어디서 지켜보는지, 그리고 작업을 하는 선원에게 지시하는 방법이에요.
---

작업은 일등항해사가 지켜보는 일 하나로, `WEB-12` 같은 키가 붙어요.
선원은 작업의 일을 하는 AI 도우미로, 프로젝트의 자기 작업 사본에서 일해요.
모든 작업은 무엇을 요청했는지, 무엇이 바뀌었는지, 근거, 그리고 무엇을 결정했는지 기록을 남겨요.

## 작업의 상태 {#where-a-task-stands}

창 오른쪽의 작업은 작업을 상태별로 보여 줘요:

- **선장님을 기다림**: 작업의 카드에 선장님의 결정이 필요해요.
- **작업 중**: 지금 선원이 일하고 있어요.
- **대기 중**: 다른 작업처럼 기다리는 것이 끝나면 저절로 시작해요.
- **백로그**: 선장님이 시작하기를 기다려요.
  시작하고 싶을 때 그 줄의 **시작**을 누르세요.
- **완료 · 7일**: 이번 주에 끝났어요.

줄에는 제목 뒤에 "막힘", "보류", "검사", "시작하지 못함" 같은 말이 붙을 수 있어요.
시작하지 못한 작업에는 **다시 시도**가 있어요.

줄을 클릭하면 작업이 열려요.
선장님을 기다리는 카드가 있으면 그 카드가 먼저 앞으로 나와요.

### 작업 옆의 표시 {#the-mark-beside-each-task}

작업의 줄마다 작은 표시로 시작해요.
모양은 작업의 상태를 알려 주고, 색은 그것을 뒷받침해요.

- <svg class="task-mark" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.2"/></svg> **백로그**: 선장님이 **시작**을 누르기를 기다려요.
- <svg class="task-mark" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.2"/><circle cx="8" cy="8" r="2" fill="currentColor"/></svg> **대기 중**: 할 수 있을 때 저절로 시작해요.
- <svg class="task-mark" viewBox="0 0 16 16" aria-hidden="true"><circle class="task-mark-track" cx="8" cy="8" r="5" fill="none" stroke-width="1.5"/><path class="task-mark-ring" d="M8 3a5 5 0 1 1-5 5" fill="none" stroke-width="1.5"/></svg> **시작 중**: Infinitary가 선원을 준비하고 있어요.
- <svg class="task-mark task-mark-hot" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="currentColor" stroke="currentColor" stroke-width="1.2"/></svg> **작업 중**: 지금 선원이 일하고 있어요.
- <svg class="task-mark task-mark-hot" viewBox="0 0 16 16" aria-hidden="true"><circle class="task-mark-ring" cx="8" cy="8" r="6" fill="none" stroke-width="1.2" stroke-dasharray="2.6 2.1"/><circle cx="8" cy="8" r="3" fill="currentColor"/></svg> **작업 중, 백그라운드 작업**: 긴 빌드나 테스트 실행처럼 선원이 시작한 것이 아직 실행 중이에요.
- <svg class="task-mark task-mark-calm" viewBox="0 0 16 16" aria-hidden="true"><circle class="task-mark-ring" cx="8" cy="8" r="6" fill="none" stroke-width="1.2" stroke-dasharray="2.6 2.1"/><circle cx="8" cy="8" r="3" fill="currentColor"/></svg> **작업 중, 검사 기다리는 중**: 선원이 변경의 검사가 끝나기를 기다려요.
  줄에 "검사"가 붙어요.
- <svg class="task-mark task-mark-calm" viewBox="0 0 16 16" aria-hidden="true"><path d="M11.441 3.085 A6 6 0 0 1 11.441 12.915 M4.559 12.915 A6 6 0 0 1 4.559 3.085" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><circle cx="8" cy="8" r="3" fill="currentColor"/></svg> **작업 중, 일괄 실행 기다리는 중**: 승인된 변경이 합류한 일괄 실행의 검사를 기다려요.
  줄에 "일괄"이 붙어요.
- <svg class="task-mark task-mark-ok" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="currentColor" stroke="currentColor" stroke-width="1.2"/></svg> **쉬는 중**: 시작했지만 지금은 선원이 일하지 않고, 작업 내용은 보관돼요.
  다른 작업을 기다릴 때는 줄에 "대기"가 붙어요.
- <svg class="task-mark task-mark-lava" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="currentColor" stroke="currentColor" stroke-width="1.2"/></svg> **중간에 멈춤**: 선원의 차례가 끝나기 전에 멈췄어요.
  다음에 할 일을 알려 주세요.
- <svg class="task-mark task-mark-calm" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.2"/><circle cx="8" cy="8" r="3" fill="currentColor"/></svg> **선장님을 기다림**: 작업의 카드에 선장님의 결정이 필요해요.
- <svg class="task-mark" viewBox="0 0 16 16" aria-hidden="true"><path d="M2 8 6 12 14 3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg> **완료**: 끝났어요.
- <svg class="task-mark task-mark-dim" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 3 13 13 M13 3 3 13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg> **중단됨**: 중단했어요.
  중단된 작업은 작업이 아니라 작업 보드에 보여요.

작업이 실행되는 컴퓨터에 연락이 닿지 않으면, 표시는 모양을 유지한 채 주황색으로 바뀌고 줄 끝에 "연락 닿지 않음"이 붙어요([다른 컴퓨터](/ko/your-other-computers/#a-computer-that-runs-work)).
예를 들어 그 컴퓨터의 백로그 작업은 <svg class="task-mark task-mark-hot" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.2"/></svg> 표시로 보여요.

여러 부분으로 나눈 작업은 그 아래에 부분들을 보여 줘요.
부분 중 하나가 시작되면 작업은 작업 중 아래에 나타나고, 열린 부분들이 그 아래에 보여요.
작업은 그곳에서도 자기 표시를 유지하므로, 부분들이 일을 하는 작업은 작업 중 아래에서 백로그나 대기 중 표시를 보여 줄 수 있어요.

작업의 상태와 그 이유를 글로 읽으려면, 그 줄에 포인터를 올리거나 키보드로 그 줄로 이동하세요.

## 작업 보드 {#the-task-board}

더 넓게 보려면 작업 머리글의 **작업 보드 열기**를 누르세요.
보드는 맨 위에 선장님을 기다림을, 그 아래에 백로그, 대기 중, 작업 중 세 열을 보여 줘요.

<img class="picture-dark" src="/pictures/task-board-dark.webp" alt="작업 보드: 프로젝트의 태그 줄, 맨 위에 선장님을 기다리는 작업 하나, 그 아래에 백로그, 대기 중, 작업 중 열." width="876" height="493" />
<img class="picture-light" src="/pictures/task-board-light.webp" alt="작업 보드: 프로젝트의 태그 줄, 맨 위에 선장님을 기다리는 작업 하나, 그 아래에 백로그, 대기 중, 작업 중 열." width="876" height="493" />

보드의 보기에서는 백로그 전체, 완료 · 7일, 이번 주에 중단된 작업도 볼 수 있어요.
**작업 찾기**에 키나 제목을 입력하면, 오래전에 끝난 작업을 포함해 모든 줄이 좁혀져요.
프로젝트에 태그가 있으면 보드에 태그 줄이 보이고, 태그 하나를 누르면 보드가 그 태그가 붙은 작업으로 좁혀져요. [태그](#tags)를 보세요.

작업을 옮기려면 타일을 다른 열로 끌거나 ⋯ 메뉴를 쓰세요:

- **대기 중**으로 옮기면 할 수 있을 때 저절로 시작해요.
- **작업 중**으로 옮기면 지금 시작해요.
- **백로그**로 되돌리면 다시 선장님의 말을 기다려요.
  이미 시작한 작업은 작업 내용을 유지해요.
- **작업 중단** 칸으로 옮기면 중단돼요.

일을 시작하거나 중단하게 되는 이동은 먼저 한 번 물어봐요.
보드는 아무것도 병합하지 않아요: 병합은 작업의 병합 카드에서만 일어나요.

## 작업 카드 {#a-tasks-card}

작업을 열면 작업 카드가 보여요.
제목 아래에 탭이 한 줄 있어요:

- **정보**: 무엇을 요청했는지, 상태, 태그, 그리고 어떻게 전달되는지예요.
- **카드**: 작업이 보여 준 카드와 그 개수예요.
- **활동**: 작업이 쓴 모든 줄을 순서대로 보여 줘요.
- **선원**: 선원이 일하는 동안의 대화를 한 줄씩 보여 줘요.
- **브라우저**: 선원이 자기 브라우저에서 연 페이지가 있으면 보여 줘요.
  [선원들의 브라우저](/ko/the-crews-browser/)를 보세요.

탭은 작업에 그곳에서 보여 줄 것이 생길 때만 나타나요.

## 태그 {#tags}

작업에는 버그나 기능처럼 그 프로젝트의 태그 중 어느 것이든 붙일 수 있어요.
프로젝트의 태그는 설정 → 프로젝트에서 만들어요. [프로젝트](/ko/projects/#tags)를 보세요.

작업에 태그를 붙이려면 작업의 **정보** 탭을 열고 **태그** 줄의 **태그 편집**을 누르세요.
메뉴에 프로젝트의 태그가 나열되고, 체크할 때마다 바로 저장돼요.
**태그** 줄은 프로젝트에 태그가 있어야 보여요.
일등항해사에게 작업에 태그를 붙여 달라고 할 수도 있어요.

태그로 작업을 찾을 수 있는 곳은 세 군데예요:

- 작업 머리글의 **작업 검색**은 프로젝트의 태그 줄을 보여 줘요.
  태그를 누르면 그 태그가 붙은 작업만 나열되고, **태그 없음**을 누르면 태그가 없는 작업이, **모든 태그**를 누르면 다시 모든 작업이 나열돼요.
- 그 옆의 **작업 묶기**는 작업을 **상태별** 대신 **태그별**로 나열해요.
  태그마다 묶음 하나가 되고, 열기 전까지는 접혀 있어요.
- 작업 보드에도 태그 줄이 따로 있고, 보드의 **태그별** 보기는 태그마다 작업을 상태별로 세어 보여 줘요.

태그는 한 번에 한 프로젝트의 것만 보여요: 집중하고 있는 프로젝트이거나, 태그가 있는 프로젝트가 하나뿐이면 그 프로젝트예요.
프로젝트에 집중하는 방법은 [프로젝트](/ko/projects/#focus-on-one-project)를 보세요.

## 선원에게 지시하기 {#steering-a-crewmate}

선원에게 말을 전하는 방법은 세 가지예요:

1. 선원의 카드 아래에 입력하고 **채팅**을 누르세요.
2. **선원** 탭 아래쪽의 상자에 입력하세요.
   일하고 있는 선원은 일하면서 선장님의 말을 받아들이고, 쉬고 있는 선원은 그 말로 다시 시작해요.
3. 메시지 상자에서 일등항해사에게 말하세요.

선원의 차례를 멈추려면 선원 탭의 **중지**를 누르세요.
작업은 열린 채로 있고, 다음에 할 일을 알려 줄 수 있어요.

## 주의 수준 {#rigor}

주의 수준은 일이 선장님께 닿기 전에 얼마나 꼼꼼하게 확인하는지예요.
세 가지 수준이 있어요:

- **빠르게**: 검사를 통과하는 정도예요.
- **기본**: 선원이 사진과 함께 변경이 작동하는 모습을 보여 주고, 중요한 테스트를 실행해요.
- **신중하게**: 기본에 더해, 병합 카드 전에 독립적인 검토와 변경이 작동한다는 증명을 거쳐요.

프로젝트마다 설정 → 프로젝트에 자기 주의 수준이 있어요.
작업 하나에 대해서는 "이건 신중하게 해 줘"처럼 요청할 때 얼마나 신중할지 말하세요.
병합 카드에서 **신중하게 검토**를 누르면 그 작업이 신중하게로 올라가요.

## 병합 전에 묻기 {#asking-before-merging}

프로젝트마다 병합 전에 묻거나 알아서 병합해요.
설정 → 프로젝트의 **병합 전에 묻기** 스위치로 정해요.
켜져 있으면 끝난 일이 병합 카드를 기다려요.
꺼져 있으면 검사를 통과한 일은 묻지 않고 병합될 수 있고, 그 뒤에 스토리가 담긴 카드를 받아요.
작업 하나만 바꾸려면 일등항해사에게 말하세요.

## 작업 닫기 {#closing-a-task}

대부분의 작업은 저절로 닫혀요:

- 변경을 병합하면 작업이 닫혀요.
- 병합 카드의 **폐기**는 그 일을 버려요.
- 질문에 답하는 알림의 **완료**는 답을 받은 것으로 작업을 닫아요.

작업 카드에서 직접 닫을 수도 있어요:

- **작업 중단**은 작업을 끝내요.
  일하고 있던 선원은 멈추고, 끝나지 않은 작업 내용은 보관돼요.
- 시작한 작업의 **완료로 닫기**는 일이 끝났다고 알려요.

닫힌 작업은 기록을 유지해요.
중단된 작업은 일주일 동안 읽기 전용으로 보드에 남아요.
