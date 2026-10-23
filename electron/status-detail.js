// Only evidence-backed categories: never infer another login from a timeout.
function sessionReason(error) {
  const message = String(error?.message || error || '');
  if (/其他地方登录|异地登录|别处登录|另一.*登录|其他设备登录/.test(message)) return '异地登录（页面明确提示）';
  if (error?.code === 'SESSION_EXPIRED' || /登录已过期|登录状态已失效|会话.*失效/.test(message)) return '登录会话失效（无法确认是否自然过期）';
  if (/timeout|超时|ERR_|网络|fetch failed|ECONN|ENOTFOUND/i.test(message)) return '网络或加载异常（不等同掉线）';
  return '页面或状态校验异常（原因未确认）';
}

function telegramFault(error) {
  const message = String(error?.message || error || '');
  if (error?.code === 'COMMAND_CONFIRMATION_REQUIRED' || /SEND_UNCERTAIN/.test(message)) return '发送结果待确认';
  const status = Number(error?.status) || Number(message.match(/(?:HTTP[_\s(]*|发送失败[（(])(\d{3})/i)?.[1]);
  if (status >= 500) return `中转或上游服务异常（HTTP ${status}）`;
  if (status >= 400) return `服务拒绝请求（HTTP ${status}）`;
  if (/timeout|超时/i.test(`${error?.code || ''} ${message}`)) return '连接或响应超时';
  return '网络连接或服务异常（未取得明确响应）';
}

function finishDrawRead(status) {
  const draw = status.drawTrigger;
  if (!draw?.enabled || draw.state !== '已检测开奖，正在读取' || draw.nextReadAt) return;
  draw.state = ['ok', 'triggered'].includes(status.status) ? '读取完成，等待下一期开奖'
    : status.status === 'partial' ? '部分读取完成，等待分支重试或下一期开奖'
      : status.status === 'manual' ? '读取暂停，等待人工处理'
        : status.status === 'error' ? '读取失败，等待重试' : '等待下一次检测';
}

module.exports = { sessionReason, telegramFault, finishDrawRead };
