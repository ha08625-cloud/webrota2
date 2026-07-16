## Provisional Plan: Implementing the Three-Tier Priority System

### Scope
Fix phase 8 issues.  When we initially ported the google apps script, there were some subtleties in the behaviour which did not transfer into the new python based script, so I want to correct these.

This is the correct behaviour for what was called phase 8 in the old google apps script, and is now called pass 2 in backend/app/engine/phases/phase7_9a.py:

Identify trainees and AHPs who still need rooms. Looks for single sessions (but doesnt exclude double AM+PM sessions - this allows pass 2 to pick up any trainees or AHPs that couldnt be assigned in pass 1)

The Three-Tier Priority System
If a senior doctor is eligible to be moved, the script looks at the rest of their day to decide how disruptive moving them would be. It groups them into three priority levels (Priority 1 gets moved first):

Priority 1 (Least Disruptive): The doctor is only working one session that day (e.g., they are on leave or have no surgery in the afternoon). Moving them doesn't disrupt a full-day setup.

Priority 2: The doctor is working all day, but they are already scheduled to switch to a different room in the afternoon anyway.

Priority 3 (Most Disruptive): The doctor is scheduled to be in the exact same D room all day

Making the Assignments (The Two Passes)
Once the script knows who needs a room and who can be moved, it starts processing the rota session by session using a two-pass system:

Pass 1 (The Easy Fix): It first checks if there are any completely empty D rooms. If there are, it assigns the Trainee/AHP directly to that room. No senior doctors are disrupted.

Pass 2 (The Bump): If there are no empty D rooms, it looks at the fairness ranking and the priority groups. It picks the most eligible senior doctor (e.g., a Priority 1 doctor who hasn't been moved yet this week). It moves that doctor into an alternative available room (like C1-C3, W1-W2, or SR, checking their personal room preferences first) and gives their original D room to the Trainee/AHP.

Pass 1 and 3 will be corrected in a separate ticket

### 1. Define the Priority Logic

We will create a new helper function, `_determine_displacement_priority()`, which evaluates a displaceable doctor's schedule for the day to return their priority tier (1, 2, or 3).

For a given doctor, day, and the period we are trying to clear (e.g., `Period.AM` in a specific D room):

* **Check the "other" period:** We look up the doctor's slot for the opposite time of day (if we are evaluating AM, we look at PM).
* **Assign Priority 1 (Only one session):**
* If the other slot is `None`.
* If the other slot `is_on_leave`.
* If the other slot has no `assigned_room_id` (meaning they don't require a room for that session, or haven't been assigned one yet).


* **Assign Priority 2 (Switching rooms anyway):**
* If the other slot *does* have an `assigned_room_id`, but it does not match the D room they are currently in.


* **Assign Priority 3 (Same D room all day):**
* If the other slot's `assigned_room_id` exactly matches the D room we are trying to displace them from.



### 2. Update the Sorting Mechanism in Pass 2

Currently, `_find_single_session_displacement` sorts candidates solely by a fairness score:

```python
candidates.sort(key=lambda c: _room_move_sort_key(context, counters, c[0]))

```

We will update this sort key so that it evaluates as a tuple: `(Priority Tier, Fairness Score, Doctor Code)`.
Python's built-in sorting handles tuples sequentially, meaning it will perfectly group candidates by Priority 1, 2, and 3. If there are multiple Priority 1 doctors, it will automatically fall back to the fairness score to decide who gets bumped.

### 3. Review Edge Cases and Assumptions

* **Impact on Pass 1:** Pass 1 handles *full-day* displacements. By definition, Pass 1 only targets doctors who are in the exact same D room all day (`occ_am == occ_pm`). Therefore, Pass 1 only ever disrupts Priority 3 doctors, but it moves them to a new room for the *entire* day (keeping their day unified). No changes are needed there; Pass 2 is where the surgical single-session bumping happens.
* **Unassigned PM Rooms:** Because Pass 3 (Partner fallback) hasn't run yet, a senior doctor might theoretically be working a PM session but not have a room assigned yet. Under our logic, this would classify them as Priority 1 for an AM bump. This is the correct behavior: since they don't have an established full-day room setup to protect, bumping their AM session won't fragment a unified day.

---