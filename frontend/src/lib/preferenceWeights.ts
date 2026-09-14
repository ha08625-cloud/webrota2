import type { PreferenceWeight } from "@/api/types";

/**
 * The dropdown options for both preference columns
 * (`supervision_preference` and `wfh_preference`), which share the
 * PreferenceWeight enum and therefore share one option list. Defined
 * once here rather than in each component: the Doctors page and the
 * doctor dialog both render it, and a value that appeared in one list
 * but not the other would be silently unsettable from that screen.
 *
 * Order is the enum's own least-to-most order, not alphabetical, so the
 * dropdown reads as a scale.
 */
export const PREFERENCE_OPTIONS: { value: PreferenceWeight; label: string }[] = [
  { value: "none", label: "None" },
  { value: "less", label: "Less" },
  { value: "normal", label: "Normal" },
  { value: "more", label: "More" },
];
