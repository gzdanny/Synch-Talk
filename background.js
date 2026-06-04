// background.js

/**
 * 根据用户输入、语言设置和模式，为AI模型构建动态提示。
 * @param {string} userInput - 用户输入的文本。
 * @param {string[]} targetLanguages - 目标语言数组。
 * @param {boolean} isTutorMode - 是否启用AI导师模式。
 * @param {boolean} isGemini - 是否为Gemini模型（影响提示格式）。
 * @returns {string} - 构建好的AI提示字符串。
 */
function buildDynamicPrompt(userInput, targetLanguages, isTutorMode, isGemini) {
  const targetLanguagesString = targetLanguages.join(', ');
  const translationsExample = targetLanguages.slice(0, 2).map(lang => `"${lang}": "..."`).join(', ');

  const persona = `You are a professional linguistic expert and localization specialist proficient in ${targetLanguagesString}.`;
  
  const rules = `
  ### Strict Rules for Translation
  - **Localization over Literalism**: Do NOT translate word-for-word. Focus on capturing the underlying meaning, tone, and cultural context.
  - **Professional Terminology**: Identify professional, technical, or industry-specific terms. Research or apply their standardized target-language equivalents (industry-standard nomenclature) rather than literal translations.
  - **Native Fluency**: The output must sound as if it were written by a native speaker in each target language.
  - **Exclusion Rule**: The "translations" object MUST NOT contain the detected source language.`;

  if (isGemini) {
    const safeUserInput = JSON.stringify(userInput);
    let taskDescription = isTutorMode ? 
    `### Task
    1. **Detect** the source language of the input.
    2. **Polish** the input text for natural flow, grammatical accuracy, and idiomatic correctness (store in "corrected_text").
    3. **Translate** the polished text into the OTHER active languages in the list: ${targetLanguagesString}.` :
    `### Task
    1. **Detect** the source language of the input.
    2. **Translate** the input text into the OTHER active languages in the list: ${targetLanguagesString}.`;

    const format = `
    ### Output Format (JSON Only)
    {
      "mode": "${isTutorMode ? 'tutor' : 'translator'}",
      "detected_source_language": "...",
      ${isTutorMode ? '"corrected_text": "...",' : ''}
      "translations": {
        ${translationsExample}
      }
    }`;

    // 重新组合顺序：身份 -> 用户输入 -> 任务 -> 规则 -> 格式
    return `${persona}

### User Input to Process:
<<<<
${safeUserInput}
>>>>

${taskDescription}

${rules}

${format}

**Final Requirement**: Provide your output ONLY in a valid JSON format. Do not include any conversational text outside the JSON.`;
  } else {
    // OpenAI 兼容格式
    const systemPrompt = `${persona}
    ${isTutorMode ? 'Task: Detect source, Polish input (store in "corrected_text"), and Translate to OTHER active languages.' : 'Task: Detect source and Translate to OTHER active languages.'}
    Active languages: ${targetLanguagesString}.
    ${rules}
    
    Output JSON keys: "mode", "detected_source_language", ${isTutorMode ? '"corrected_text", ' : ''}"translations".`;

    return systemPrompt;
  }
}

/**
 * 为“反向校验”功能构建提示，要求将文本翻译为自然对话式的英语。
 * @param {string} textToTranslate - 需要翻译以进行校验的文本。
 * @returns {string} - 构建好的AI提示字符串。
 */
function buildReverseCheckPrompt(textToTranslate) {
  const safeTextToTranslate = JSON.stringify(textToTranslate);
  return `Translate the following text into conversational English, and provide ONLY the translation without any extra text.
  Text: ${safeTextToTranslate}`;
}

/**
 * 清理和规范化来自AI API的响应文本。
 * 移除Markdown代码块、多余的逗号，并尝试解析为JSON。
 * @param {string} text - 从API获取的原始响应文本。
 * @returns {string|object} - 如果能解析为JSON，则返回解析后的对象或其中的'text'字段；否则返回清理后的字符串。
 */
function cleanApiResponse(text) {
  // 移除Markdown代码块标记 (```json ... ```)
  const codeBlockMatch = text.match(/```json\s*([\s\S]*?)\s*```/);
  let cleanedText = codeBlockMatch ? codeBlockMatch[1].trim() : text.trim();

  // 移除JSON中可能导致解析错误的尾随逗号
  cleanedText = cleanedText.replace(/,(\s*[}\]])/g, '$1');

  // 尝试将清理后的文本解析为JSON
  try {
    const parsed = JSON.parse(cleanedText);
    // 如果解析后的对象有 'text' 属性（常见于简单文本响应），则直接返回其值
    if (parsed.text) {
      return parsed.text.trim();
    }
    // 否则返回整个解析后的对象
    return parsed;
  } catch (e) {
    // Not JSON, return directly
    return cleanedText;
  }
}

// Helper function: Standardize API call handling
/**
 * 封装的fetch调用，用于向AI服务发起API请求。
 * @param {string} provider - API提供商名称（如 'Gemini', 'OpenAI'），用于日志记录。
 * @param {string} endpoint - API的URL端点。
 * @param {object} headers - 请求头。
 * @param {object} body - 请求体（将被JSON.stringify）。
 * @returns {Promise<object>} - 返回一个包含API响应数据或错误信息的对象。
 */
async function makeApiCall(provider, endpoint, headers, body) {
  console.log(`[${provider}] Making API call to: ${endpoint}`);
  console.log(`[${provider}] Request Headers:`, headers);
  console.log(`[${provider}] Request Body:`, body);
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`API Error Response from ${provider}:`, errorText);
      throw new Error(`API Error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    return data;

  } catch (error) {
    console.error(`API call to ${provider} failed:`, error);
    return { error: `Unable to connect to ${provider} API: ${error.message}` };
  }
}

// ---- API Core Functionality ----

/**
 * 处理AI输入的核心函数，根据用户设置调用不同的AI服务进行翻译或语法修正。
 * @param {string} userInput - 用户输入的文本。
 * @param {string[]} targetLanguages - 目标语言数组。
 * @param {boolean} isTutorMode - 是否启用AI导师模式。
 * @returns {Promise<object>} - 返回一个包含翻译结果、修正文本或错误信息的对象。
 */
async function processAiInput(userInput, targetLanguages, isTutorMode) {
  console.log('background.js: processAiInput called', { userInput, targetLanguages, isTutorMode });
  const settings = await chrome.storage.local.get(['aiProvider', 'geminiApiKey', 'geminiModel', 'openAiUrl', 'openAiApiKey', 'openAiModel']);
  const provider = settings.aiProvider || 'gemini';

  let prompt;
  let apiResponse;
  let responseData;

  if (provider === 'gemini') {
    if (!settings.geminiApiKey) {
      return { error: 'Please set your Gemini API key in the options page.' };
    }
    const model = settings.geminiModel || 'gemini-flash-latest'; // Default to gemini-flash-latest if not set
    prompt = buildDynamicPrompt(userInput, targetLanguages, isTutorMode, true);
    console.log(`[Gemini] Generated Prompt:\n${prompt}`);
    const body = { contents: [{ parts: [{ text: prompt }] }] };
    const headers = { 'Content-Type': 'application/json', 'X-goog-api-key': settings.geminiApiKey };
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
    apiResponse = await makeApiCall('Gemini', endpoint, headers, body);

    if (apiResponse.error) return apiResponse;
    const cleanedContent = cleanApiResponse(apiResponse.candidates[0].content.parts[0].text);

    try {
      // cleanedContent可能已经是对象了
      responseData = typeof cleanedContent === 'string' ? JSON.parse(cleanedContent) : cleanedContent;
    } catch (e) {
      return { error: `Invalid JSON format returned by Gemini API: ${e.message}` };
    }

  } else if (provider === 'openai') {
    const { openAiUrl, openAiApiKey, openAiModel } = settings;
    if (!openAiUrl || !openAiApiKey || !openAiModel) {
      return { error: 'Please set your OpenAI-compatible API URL, key, and model in the options page.' };
    }
    prompt = buildDynamicPrompt(userInput, targetLanguages, isTutorMode, false);
    console.log(`[OpenAI] Generated Prompt:\n${prompt}`);
    const body = {
      model: openAiModel,
      response_format: { type: "json_object" },
      messages: [{ role: "system", content: prompt }, { role: "user", content: userInput }]
    };
    const headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${openAiApiKey}` };
    apiResponse = await makeApiCall('OpenAI', openAiUrl, headers, body);

    if (apiResponse.error) return apiResponse;
    const cleanedContent = cleanApiResponse(apiResponse.choices[0].message.content);

    try {
      // cleanedContent可能已经是对象了
      responseData = typeof cleanedContent === 'string' ? JSON.parse(cleanedContent) : cleanedContent;
    } catch (e) {
      return { error: `Invalid JSON format returned by OpenAI API: ${e.message}` };
    }

  } else {
    return { error: 'Unknown AI service provider.' };
  }
  return responseData;
}

/**
 * 执行“反向校验”，将一段文本翻译回英语以供用户核对。
 * @param {string} textToTranslate - 需要被翻译的文本。
 * @returns {Promise<object>} - 返回一个包含翻译结果或错误信息的对象。
 */
async function performReverseCheck(textToTranslate) {
  const settings = await chrome.storage.local.get(['aiProvider', 'geminiApiKey', 'geminiModel', 'openAiUrl', 'openAiApiKey', 'openAiModel']);
  const provider = settings.aiProvider || 'gemini';

  const prompt = buildReverseCheckPrompt(textToTranslate);
  let apiResponse;
  let content;

  if (provider === 'gemini') {
    if (!settings.geminiApiKey) {
      return { error: 'Please set your Gemini API key in the options page to use the reverse check function.' };
    }
    const model = settings.geminiModel || 'gemini-flash-latest'; // Default to gemini-flash-latest if not set
    const body = { contents: [{ parts: [{ text: prompt }] }] };
    const headers = { 'Content-Type': 'application/json', 'X-goog-api-key': settings.geminiApiKey };
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
    apiResponse = await makeApiCall('Gemini', endpoint, headers, body);
    if (apiResponse.error) return apiResponse;
    content = apiResponse.candidates[0].content.parts[0].text;

  } else if (provider === 'openai') {
    const { openAiUrl, openAiApiKey, openAiModel } = settings;
    if (!openAiUrl || !openAiApiKey || !openAiModel) {
      return { error: 'Please set your OpenAI-compatible API to use the reverse check function.' };
    }
    const body = { model: openAiModel, messages: [{ role: "user", content: prompt }] };
    const headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${openAiApiKey}` };
    apiResponse = await makeApiCall('OpenAI', openAiUrl, headers, body);
    if (apiResponse.error) return apiResponse;
    content = apiResponse.choices[0].message.content;

  } else {
    return { error: 'Unknown AI service provider.' };
  }

  // Clean the response to ensure it is plain text
  const cleanedText = cleanApiResponse(content);

  return { text: cleanedText.trim() };
}

/**
 * 测试用户提供的API配置是否有效。
 * @param {string} provider - AI提供商 ('gemini' 或 'openai')。
 * @param {object} settings - 包含API密钥、URL等设置的对象。
 * @returns {Promise<object>} - 返回一个包含测试成功与否及相关信息的对象。
 */
async function testApi(provider, settings) {
  let prompt, body, headers, endpoint;

  if (provider === 'gemini') {
    if (!settings.apiKey) return { success: false, error: 'Please enter your Gemini API key.' };
    const model = settings.model
    prompt = "Test API connectivity. Respond with a single word: 'OK'.";
    body = { contents: [{ parts: [{ text: prompt }] }] };
    headers = { 'Content-Type': 'application/json', 'X-goog-api-key': settings.apiKey };
    endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  } else if (provider === 'openai') {
    if (!settings.url || !settings.apiKey || !settings.model) {
      return { success: false, error: 'Please fill in all OpenAI-compatible interface settings.' };
    }
    prompt = "Test API connectivity. Respond with a single word: 'OK'.";
    body = { model: settings.model, messages: [{ role: "user", content: prompt }] };
    headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${settings.apiKey}` };
    endpoint = settings.url;

  } else {
    return { success: false, error: 'Testing this provider is not supported.' };
  }

  const apiResponse = await makeApiCall(provider, endpoint, headers, body);
  if (apiResponse.error) {
    return { success: false, error: apiResponse.error };
  }

  let content;
  if (provider === 'gemini') {
    content = apiResponse.candidates[0].content.parts[0].text;
  } else {
    content = apiResponse.choices[0].message.content;
  }

  // Clean the test result to ensure proper logic
  const cleanedContent = cleanApiResponse(content);

  if (cleanedContent && cleanedContent.trim().toLowerCase().includes('ok')) {
    return { success: true, message: 'API configuration successful!' };
  } else {
    return { success: false, error: `API returned unexpected response: ${cleanedContent}` };
  }
}

// ---- Chrome Extension Event Listeners ----

/**
 * 扩展安装或更新时运行，确保侧边栏在所有页面都可用。
 */
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setOptions({
    enabled: true
  });
});

/**
 * 监听工具栏图标点击事件，打开侧边栏。
 */
chrome.action.onClicked.addListener(async (tab) => {
  await chrome.sidePanel.open({ tabId: tab.id });
});

/**
 * 统一的消息监听器，处理来自内容脚本、弹出窗口和选项页面的请求。
 * 使用 'action' 或 'type' 字段来分发请求到相应的处理函数。
 */
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'processInput') {
    const { userInput, targetLanguages, isTutorMode } = request;
    processAiInput(userInput, targetLanguages, isTutorMode).then(sendResponse);
    return true;
  } else if (request.action === 'reverseCheck') {
    const { textToTranslate } = request;
    performReverseCheck(textToTranslate).then(sendResponse);
    return true;
  } else if (request.action === 'testApi') {
    const { provider, ...settings } = request;
    testApi(provider, settings).then(sendResponse);
    return true;
  } else if (request.type === 'captureContent') {
    // 处理来自内容脚本(content.js)的消息，捕获页面内容。
    // 将文本、URL和标题存储在 chrome.storage.session 中，以便侧边栏(popup.js)可以访问。
    chrome.storage.session.set({ capturedContent: { text: request.text, url: request.url, title: request.title } });
  }
});
