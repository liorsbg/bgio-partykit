async function init() {
  const status = document.getElementById('status');
  try {
    const res = await fetch('/health');
    const data = await res.json();
    status.textContent = `Service: ${data.service} | Status: ${data.status} | Games: ${data.games.join(', ')}`;
  } catch (err) {
    status.textContent = 'Error: ' + err.message;
  }
}

init();
