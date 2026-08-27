# Waffle Party Control Refinements

## Problem Statement

The call tile has no way to stop watching a joined plugin, card controls vanish
while the tile renders, and queue navigation does not respect loop mode.

## Goals

- [x] Let a viewer leave a joined plugin tile and return playback rendering to chat.
- [x] Keep shared card controls available during call rendering.
- [x] Make recreation and loop/navigation controls match the requested behavior.

## Out of Scope

- Synchronizing local volume between users.
- Changing browser autoplay policy behavior.

## Assumptions & Open Questions

| Decision | Chosen behavior | Confirmed? |
| --- | --- | --- |
| Active party | A non-closed party whose members include the current user. | y |
| Stop watching | It is local to the viewer and does not alter shared party membership or playback. | y |

**Open questions:** none.

## User Stories

### P1: Control a party consistently

**User Story**: As a listener, I want to leave the call tile, use controls from
chat, and navigate a looped queue predictably so shared playback stays usable.

**Why P1**: The requested controls are all part of one playback interaction.

## Acceptance Criteria

1. WHILE a plugin call tile is joined, the system SHALL render a red Stop watching plugin control which removes only that local tile join. <!-- state-driven -->
2. WHEN Stop watching plugin is activated, THEN the system SHALL unmount the call tile renderer and allow the chat card renderer to resume. <!-- event-driven -->
3. WHEN a Waffle Party is rendering in a call, THEN the chat card SHALL keep its shared playback, queue, loop, and volume controls available. <!-- state-driven -->
4. WHEN a closed party is otherwise eligible for recreation but the user belongs to another active party, THEN the system SHALL not render the recreation control. <!-- unwanted-behavior -->
5. WHEN the user activates the loop button, THEN the system SHALL cycle loop mode in the order off, track, queue, off. <!-- event-driven -->
6. WHEN next is activated at the final queue item, THEN track loop SHALL restart that item, queue loop SHALL select the first item, and loop off SHALL stop playback. <!-- event-driven -->
7. WHEN previous is activated, THEN the system SHALL select the prior queue item; at the first item queue loop SHALL select the final item and track loop SHALL restart the current item. <!-- event-driven -->
8. WHEN an eligible closed party renders its recreation control, THEN the system SHALL center an icon-free `Recruwuate party :3` button with a muted gray background. <!-- state-driven -->
9. WHEN a party card renders its seek bar, THEN the system SHALL show the current and total video time in `m:ss / m:ss` form. <!-- state-driven -->
10. WHEN a party member views the loop control, THEN the system SHALL show its mode through an icon and tooltip without rendering a textual mode label. <!-- state-driven -->
11. WHEN party controls render, THEN loop and leave/disband SHALL occupy a right-aligned control group with leave/disband as its final action. <!-- state-driven -->
12. WHEN the call tile is the active renderer, THEN the chat card timer and playback actions SHALL use its live position, and switching renderers SHALL seed the next player from the handoff position. <!-- event-driven -->

## Requirement Traceability

| Requirement ID | Status |
| --- | --- |
| WCR-01 | Done |
| WCR-02 | Done |
| WCR-03 | Done |
| WCR-04 | Done |
| WCR-05 | Done |
| WCR-06 | Done |
| WCR-07 | Done |
| WCR-08 | Done |
| WCR-09 | Done |
| WCR-10 | Done |
| WCR-11 | Done |
| WCR-12 | Done |
