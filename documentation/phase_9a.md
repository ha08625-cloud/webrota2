# Plan
Fix phase 9a issues.  When we initially ported the google apps script, there were some subtleties in the behaviour which did not transfer into the new python based script, so I want to correct these.  I think it would be easiest to fully separate these into their individual phases again as the behaviour is quite complex.  

This is the correct behaviour for what was called phase 9a in the old google apps script, adn is now called pass 3 in backend/app/engine/phases/phase7_9a.py:

Checks Preferences: For each doctor, it looks at their room preferences from the Setup sheet (Columns C through H).

Note on Preferences: If a doctor simply prefers "C", the script automatically expands that to mean they will accept C1, C2, or C3. If they prefer "W", it expands to W1 or W2.

Tries Preferred Rooms: It checks their preferred rooms one by one against the occupancy map. If a preferred room is empty, the doctor is assigned to it, and that room is marked as "occupied" for that session.

Tries Fallback Rooms: If all of a doctor's preferred rooms are full, it forces them into the first available room using a strict fallback priority list: SR → D1 to D8 → C1 to C3 → W1 to W2.