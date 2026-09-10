// Shared category metadata: color + icon, used on the client search page
// and the provider dashboard so both stay in sync.
window.CATEGORY_COLORS = {
  'Plumbing': '#2F6169',
  'Electrical': '#B9791C',
  'Carpentry': '#8B5E34',
  'Painting': '#A24E67',
  'Cleaning': '#3B6FA0',
  'Gardening': '#6F8C3E',
  'Moving': '#5A5F73'
};

window.CATEGORY_ICONS = {
  'Plumbing': '<path d="M14.7 6.3a4 4 0 0 0-5.66 5.66L4 17l3 3 5.04-5.04a4 4 0 0 0 5.66-5.66l-2.12 2.12-2.12-.7-.7-2.12 2.12-2.12z"/>',
  'Electrical': '<path d="M13 2 4 14h6l-1 8 9-12h-6l1-8z"/>',
  'Carpentry': '<path d="M4 20l7-7M14 4l6 6-3 3-6-6 3-3zM10 10l4 4"/>',
  'Painting': '<rect x="9" y="3" width="6" height="8" rx="1"/><path d="M12 11v10M8 21h8"/>',
  'Cleaning': '<path d="M9 3l6 6M4 20l6-6M13 6l5 5-8 8-4-1 1-4 6-6z"/>',
  'Gardening': '<circle cx="12" cy="9" r="4"/><path d="M12 13v8"/>',
  'Moving': '<path d="M3 16V6h11v10M3 16h13M14 10h4l3 3v3M14 16h9M7 19a2 2 0 1 0 0-.01M18 19a2 2 0 1 0 0-.01"/>'
};

window.URGENCY_OPTIONS = [
  { value: 'now', label: 'Now', sub: 'ASAP', color: '#DC2626' },
  { value: 'today', label: 'Today', sub: 'Within hours', color: '#D97706' },
  { value: 'schedule', label: 'Schedule', sub: 'Choose a time', color: '#0B6E4F' }
];

// Rough ballpark ranges in UGX, shown as an estimate only — not a quote.
window.CATEGORY_ESTIMATES = {
  'Plumbing': '30,000 – 60,000',
  'Electrical': '40,000 – 80,000',
  'Carpentry': '35,000 – 90,000',
  'Painting': '150,000 – 500,000',
  'Cleaning': '25,000 – 70,000',
  'Gardening': '20,000 – 60,000',
  'Moving': '80,000 – 250,000'
};

window.STATUS_META = {
  'requested': { label: 'Requested', color: '#D97706', bg: '#FDF3E3' },
  'accepted': { label: 'Accepted', color: '#0B6E4F', bg: '#E6F4EC' },
  'declined': { label: 'Declined', color: '#DC2626', bg: '#FCE9E9' },
  'completed': { label: 'Completed', color: '#374151', bg: '#F0F1F0' },
  'cancelled': { label: 'Cancelled', color: '#6B7280', bg: '#F0F1F0' }
};

window.categoryColor = function (cat) {
  return window.CATEGORY_COLORS[cat] || '#2F6169';
};

window.categoryIcon = function (cat) {
  return window.CATEGORY_ICONS[cat] || window.CATEGORY_ICONS['Plumbing'];
};

window.initials = function (name) {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  const first = parts[0]?.[0] || '';
  const last = parts.length > 1 ? parts[parts.length - 1][0] : '';
  return (first + last).toUpperCase();
};
