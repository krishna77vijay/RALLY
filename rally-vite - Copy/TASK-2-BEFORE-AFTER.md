# Task 2: Before-and-after prototype changes

**Project:** RALLY  
**Prototype:** [Current prototype](./index.html)  

The changes below connect feedback gathered while iterating on the prototype to specific UI revisions. This feedback came from the project conversation; it is not presented as two formal usability tests.

## 1. Finding game invitations

**Before:** Game invitations were shown as a panel on the Find a Game page. A user asked, “where can i see game invites?” and then asked “where?” again, showing that the location was not easy to discover. The user then requested that invitations be put in the Friends section.

**After:** Invitations are in the Friends tab, inside a dropdown labeled “Game invitations.” It shows the pending invitation count and keeps the Accept & join and Decline actions with each invitation. Opening the dropdown refreshes the invitation list.

**Why this revision:** Putting invitations with Friends follows the user’s expectation that game invitations are part of their social relationships. The dropdown makes the location visible while keeping the Friends page compact.

**Sourced pattern:** The dropdown uses the native HTML disclosure pattern (`<details>` and `<summary>`), which provides an expandable/collapsible control with built-in open state and keyboard interaction. See [MDN: The Details disclosure element](https://developer.mozilla.org/en-US/docs/Web/HTML/Element/details).

**Prototype location:** [Friends tab and invitation dropdown](./index.html), `#socialFriendsPanel`, `#gameInviteDropdown`, and `renderGameInvitations`.

## 2. Game details cut off on screen

**Before:** The game-details dialog could be partly outside the visible viewport, cutting off content.

**Evidence:** The user reported that the details page “get cut off,” then clarified that it happened for Pickleball, Cricket, and Volleyball.

**After:** The dialog is positioned from the top of a scrollable backdrop, so its content can be reached within the viewport rather than being clipped by vertical centering.

**Why this revision:** A scrollable, top-aligned dialog keeps the details available on smaller screens and when the content is taller.

**Prototype location:** [Game details dialog](./index.html), `#backdrop` and `.game-details-modal`.

## 3. Showing who organizes a game

**Before:** The host area could show a generic player label instead of the organizer’s name.

**Evidence:** The user requested “needs to say player name” twice.

**After:** The game list looks up host profiles and displays the organizer’s `display_name` when profile access is available. A generic “RALLY player” label remains as a fallback if the profile cannot be read.

**Why this revision:** A name helps players identify who is organizing before deciding whether to join.

**Prototype location:** [Game list and host details](./index.html), host profile loading and game mapping. Profile visibility depends on Supabase permissions.

## Implementation note

The Friends-only game option is also present in the Create Game form as “Who can join?” with “Anyone on RALLY” and “Your friends only.” The database support is defined in [the friends-only games migration](./supabase/migrations/20261028071000_friends_only_games.sql). That migration must be applied in Supabase for the setting to work with live games.

## Evidence limitation

These are authentic design-feedback moments from iterating on RALLY, but they do not establish that two distinct people completed formal task-based usability tests. To meet the full assignment requirement, add notes from two real participants, including the task each tried, what they did or said, and three findings tagged by theme. Do not label the feedback above as two separate test participants.
