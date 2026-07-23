// One name — "Pace" — for how often a goal works on its own, shared by the
// create form, the edit form, and the card so the wording never drifts. The
// value is the goal's stored priority (1 = most often).
export const PACE_OPTIONS = [
  { value: '1', label: 'Urgent — every 6 hours' },
  { value: '2', label: 'High — daily' },
  { value: '3', label: 'Normal — twice a week' },
  { value: '4', label: 'Low — weekly' },
  { value: '5', label: 'Later — monthly' },
] as const;
