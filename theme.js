// set the saved color theme before first paint (no flash of bright colors at 3 AM)
document.documentElement.dataset.theme = localStorage.getItem('wb-theme') || 'night';
