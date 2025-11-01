document.addEventListener('DOMContentLoaded', async () => {
  const startBtn = document.getElementById('start');
  const stopBtn = document.getElementById('stop');
  const statusDiv = document.getElementById('status');

  // Get current state from background
  const response = await chrome.runtime.sendMessage({ action: 'getState' });
  updateUI(response.state);

  // Start button handler
  startBtn.addEventListener('click', async () => {
    startBtn.disabled = true;
    stopBtn.disabled = false;
    statusDiv.textContent = '正在启动自动化...';
    statusDiv.className = 'status status-active';

    await chrome.runtime.sendMessage({ action: 'startAutomation' });
  });

  // Stop button handler
  stopBtn.addEventListener('click', async () => {
    startBtn.disabled = false;
    stopBtn.disabled = true;
    statusDiv.textContent = '已停止';
    statusDiv.className = 'status status-idle';

    await chrome.runtime.sendMessage({ action: 'stopAutomation' });
  });

  // Listen for state updates from background
  chrome.runtime.onMessage.addListener((message) => {
    if (message.action === 'stateUpdate') {
      updateUI(message.state);
    }
  });

  function updateUI(state) {
    if (!state) {
      return;
    }

    if (state.active) {
      startBtn.disabled = true;
      stopBtn.disabled = false;
      statusDiv.textContent = state.currentStep || '运行中...';
      statusDiv.className = 'status status-active';
    } else {
      startBtn.disabled = false;
      stopBtn.disabled = true;
      if (state.currentStep === 'success') {
        statusDiv.textContent = state.lastCode ? `成功提交邀请码：${state.lastCode}` : '已成功提交邀请码';
        statusDiv.className = 'status status-active';
      } else if (state.error) {
        statusDiv.textContent = `已停止：${state.error}`;
        statusDiv.className = 'status status-error';
      } else if (state.currentStep && state.currentStep !== 'idle') {
        statusDiv.textContent = state.currentStep;
        statusDiv.className = 'status status-idle';
      } else {
        statusDiv.textContent = '就绪';
        statusDiv.className = 'status status-idle';
      }
    }
  }
});
