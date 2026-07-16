# Plan
Fix phase 8 issues.  When we initially ported the google apps script, there were some subtleties in the behaviour which did not transfer into the new python based script, so I want to correct these.

This is the correct behaviour for what was called phase 8 in the old google apps script, adn is now called pass 2 in backend/app/engine/phases/phase7_9a.py:

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