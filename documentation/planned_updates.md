- add nurses
- In the rota generation page, if the user selects a week that has already been cstaged or committed, then instead of "Start staging" the button should show "go to rota"
- In the rota generation page, if a user tries to click "Start staging" when the duty rota for that week is not complete, open a dialog box that says "are you sure?"
- Once a new staff member has been added, open dialog box: go to master rota to fill in clinics?
- master rota background white for most cells, darker grey for no surgery or leave
- request leave by user

- Displacing someone in the generated room - displace, swap or cancel
- trainees off site needs validation or local supervisors
- add cutteslowe kitchen

- WFH allocation phase: choose who works from home when the doctors working a
  session outnumber the rooms available, selecting on the (now live) WFH
  counter and wfh_preference. Placement and capacity constraints are written
  up in phase_pipeline.md under "Not yet implemented: WFH allocation"; needs
  its own discussion cycle before a plan
- swap-rooms can leave a session both WFH and roomed: it moves room_id without
  touching is_wfh. dragRules.ts refuses a room drop onto a WFH target so it is
  unreachable from the UI, but the API permits it. No counter effect either
  way (is_wfh does not change)
- Undoing a set-room restores the room but not the is_wfh that set-room
  cleared as a side effect, so the undone slot stays non-WFH. The WFH counter
  agrees with the session in that state, so this is a session-state gap, not a
  counter one
