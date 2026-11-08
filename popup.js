const $ = id => document.getElementById(id);
let activeTabId = null;
let currentState = "ready";

function setState(state) {
  currentState = state;
  const pill = $("statePill");
  pill.className = "status-pill" + (state === "complete" ? " ready" : state === "scanning" ? " busy" : "");
  pill.textContent = state === "scanning" ? "Scanning" : state === "complete" ? "Complete" : state === "error" ? "Issue" : "Ready";
  $("extractBtn").disabled = state === "scanning";
  $("extractLabel").textContent = state === "scanning" ? "Scanning Participants…" : state === "complete" ? "Scan Again" : "Extract Contacts";
}

function showError(message) {
  $("errorBox").textContent = message;
  $("errorBox").classList.remove("hidden");
  setState("error");
}

function updateStatus(data) {
  if (data.groupName) $("groupName").textContent = data.groupName;
  if (data.memberCount != null) $("groupMembers").textContent = `${data.memberCount} members`;
  if (data.scanned != null) $("membersValue").textContent = data.scanned;
  if (data.contactCount != null) $("contactsValue").textContent = data.contactCount;
  if (data.progress != null) {
    $("progressCard").style.display = "block";
    $("progressFill").style.width = `${Math.max(0, Math.min(100, data.progress))}%`;
    $("progressPercent").textContent = `${Math.round(data.progress)}%`;
  }
  if (data.note) $("progressNote").textContent = data.note;
  if (data.title) $("progressTitle").textContent = data.title;
  if (data.error) showError(data.error);
  if (data.done) {
    setState("complete");
    $("progressCard").style.display = "block";
    $("progressFill").style.width = "100%";
    $("progressPercent").textContent = "100%";
    $("progressTitle").textContent = "Extraction completed";
    $("progressNote").textContent = `${data.contactCount || 0} unique phone number(s) available for export.`;
    $("exportBtn").disabled = !(data.contactCount > 0);
    $("helpMessage").innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="m8 12 2.5 2.5L16 9"/></svg><span>Scan completed. Select <strong>Export Last Result (CSV)</strong> to download the contacts visible to your WhatsApp account.</span>`;
  } else if (data.scanning) {
    setState("scanning");
  }
}

chrome.runtime.onMessage.addListener(message => {
  if (message?.type === "TEJO_SCAN_STATUS") updateStatus(message.data || {});
});

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({active:true,currentWindow:true});
  if (!tab?.id || !tab.url?.startsWith("https://web.whatsapp.com/")) {
    throw new Error("Open WhatsApp Web in this tab and select the target group's info panel first.");
  }
  activeTabId = tab.id;
  return tab;
}

$("extractBtn").addEventListener("click", async () => {
  $("errorBox").classList.add("hidden");
  try {
    const tab = await getActiveTab();
    $("progressCard").style.display = "block";
    $("progressFill").style.width = "0%";
    $("progressPercent").textContent = "0%";
    $("progressTitle").textContent = "Preparing participant list…";
    $("progressNote").textContent = "Opening the full participant list.";
    setState("scanning");
    const response = await chrome.tabs.sendMessage(tab.id,{type:"TEJO_START_SCAN"});
    if (!response?.ok) showError(response?.message || "Could not start extraction.");
  } catch (e) {
    showError(e.message || "Unable to connect to WhatsApp Web; refresh the page and try again.");
  }
});

$("exportBtn").addEventListener("click", async () => {
  try {
    const tab = await getActiveTab();
    const response = await chrome.tabs.sendMessage(tab.id,{type:"TEJO_EXPORT_CSV"});
    if (!response?.ok) showError(response?.message || "No completed result is available to export.");
  } catch (e) {
    showError(e.message || "Could not export the last result.");
  }
});

// Restore the current page's latest scan summary when the popup is reopened.
(async () => {
  try {
    const tab = await getActiveTab();
    const response = await chrome.tabs.sendMessage(tab.id,{type:"TEJO_GET_STATUS"});
    if (response?.data) updateStatus(response.data);
    if (response?.groupName) $("groupName").textContent = response.groupName;
    if (response?.memberCount != null) $("groupMembers").textContent = `${response.memberCount} members`;
  } catch (_) {
    // WhatsApp Web may not be the active tab yet; the helper text explains what to do.
  }
})();