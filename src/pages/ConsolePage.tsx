/**
 * Running a local relay server will allow you to hide your API key
 * and run custom logic on the server
 *
 * Set the local relay server address to:
 * REACT_APP_LOCAL_RELAY_SERVER_URL=http://localhost:8081
 *
 * This will also require you to set OPENAI_API_KEY= in a `.env` file
 * You can run it with `npm run relay`, in parallel with `npm start`
 */
const LOCAL_RELAY_SERVER_URL: string =
  process.env.REACT_APP_LOCAL_RELAY_SERVER_URL || '';

import { useEffect, useRef, useCallback, useState } from 'react';

import { RealtimeClient } from '@openai/realtime-api-beta';
import { ItemType } from '@openai/realtime-api-beta/dist/lib/client.js';

import { instructions } from '../utils/conversation_config.js';

import { X, Edit, Zap, ArrowUp, ArrowDown } from 'react-feather';
import { Button } from '../components/button/Button';
import { Toggle } from '../components/toggle/Toggle';
import { Map } from '../components/Map';

import './ConsolePage.scss';

// 恢復之前移除的導入
import { WavStreamPlayer, WavRecorder } from '../lib/wavtools/index.js';

/**
 * Type for result from get_weather() function call
 */
interface Coordinates {
  lat: number;
  lng: number;
  location?: string;
  temperature?: {
    value: number;
    units: string;
  };
  wind_speed?: {
    value: number;
    units: string;
  };
}

/**
 * Type for all event logs
 */
interface RealtimeEvent {
  time: string;
  source: 'client' | 'server';
  count?: number;
  event: { [key: string]: any };
}

// 添加這個輔助函數來將 ArrayBuffer 轉換為 base64 字符串
function arrayBufferToBase64(buffer: ArrayBuffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return window.btoa(binary);
}

// 添加這個函數來將 PCM 數據轉換為 WAV
function pcmToWav(pcmData: Int16Array, sampleRate: number): Blob {
  const wavHeader = new ArrayBuffer(44);
  const view = new DataView(wavHeader);

  // RIFF chunk descriptor
  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + pcmData.length * 2, true);
  writeString(view, 8, 'WAVE');

  // fmt sub-chunk
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);

  // data sub-chunk
  writeString(view, 36, 'data');
  view.setUint32(40, pcmData.length * 2, true);

  const wavFile = new Blob([wavHeader, pcmData.buffer], { type: 'audio/wav' });
  return wavFile;
}

function writeString(view: DataView, offset: number, string: string) {
  for (let i = 0; i < string.length; i++) {
    view.setUint8(offset + i, string.charCodeAt(i));
  }
}



// 在 ConsolePage 函數外部定義這個對象
const SYSTEM_INSTRUCTIONS = {
  default: instructions, // 使用之前定義的默認指令
  creative: "You are a creative assistant. Your responses should be imaginative and original.",
  professional: "You are a professional assistant. Your responses should be formal and business-oriented.",
  friendly: "You are a friendly assistant. Your responses should be casual and approachable.",
  custom: "" // 添加這行
};

export function ConsolePage() {
  /**
   * Ask user for API Key
   * If we're using the local relay server, we don't need this
   */
  const apiKey = LOCAL_RELAY_SERVER_URL
    ? ''
    : localStorage.getItem('tmp::voice_api_key') ||
      prompt('OpenAI API Key') ||
      '';
  if (apiKey !== '') {
    localStorage.setItem('tmp::voice_api_key', apiKey);
  }

  /**
   * Instantiate:
   * - RealtimeClient (API client)
   */
  const clientRef = useRef<RealtimeClient>(
    new RealtimeClient(
      LOCAL_RELAY_SERVER_URL
        ? { url: LOCAL_RELAY_SERVER_URL }
        : {
            apiKey: apiKey,
            dangerouslyAllowAPIKeyInBrowser: true,
          }
    )
  );

  // 在 clientRef 定義之後添加這行
  const wavStreamPlayerRef = useRef<WavStreamPlayer>(
    new WavStreamPlayer({ sampleRate: 24000 })
  );

  /**
   * References for
   * - Autoscrolling event logs
   * - Timing delta for event log displays
   */
  const eventsScrollHeightRef = useRef(0);
  const eventsScrollRef = useRef<HTMLDivElement>(null);
  const startTimeRef = useRef<string>(new Date().toISOString());

  /**
   * All of our variables for displaying application state
   * - items are all conversation items (dialog)
   * - realtimeEvents are event logs, which can be expanded
   * - memoryKv is for set_memory() function
   * - coords, marker are for get_weather() function
   */
  const [items, setItems] = useState<ItemType[]>([]);
  const [realtimeEvents, setRealtimeEvents] = useState<RealtimeEvent[]>([]);
  const [expandedEvents, setExpandedEvents] = useState<{
    [key: string]: boolean;
  }>({});
  const [isConnected, setIsConnected] = useState(false);
  const [canPushToTalk, setCanPushToTalk] = useState(true);
  const [coords, setCoords] = useState<Coordinates | null>({
    lat: 37.775593,
    lng: -122.418137,
  });
  const [marker, setMarker] = useState<Coordinates | null>(null);

  /**
   * Added state variable for text input
   */
  const [inputText, setInputText] = useState('');

  /**
   * Added state variables for system instruction
   */
  const [systemInstructionKey, setSystemInstructionKey] = useState<keyof typeof SYSTEM_INSTRUCTIONS>('default');
  const [customSystemInstruction, setCustomSystemInstruction] = useState('');

  /**
   * Utility for formatting the timing of logs
   */
  const formatTime = useCallback((timestamp: string) => {
    const startTime = startTimeRef.current;
    const t0 = new Date(startTime).valueOf();
    const t1 = new Date(timestamp).valueOf();
    const delta = t1 - t0;
    const hs = Math.floor(delta / 10) % 100;
    const s = Math.floor(delta / 1000) % 60;
    const m = Math.floor(delta / 60_000) % 60;
    const pad = (n: number) => {
      let s = n + '';
      while (s.length < 2) {
        s = '0' + s;
      }
      return s;
    };
    return `${pad(m)}:${pad(s)}.${pad(hs)}`;
  }, []);

  /**
   * When you click the API key
   */
  const resetAPIKey = useCallback(() => {
    const apiKey = prompt('OpenAI API Key');
    if (apiKey !== null) {
      localStorage.clear();
      localStorage.setItem('tmp::voice_api_key', apiKey);
      window.location.reload();
    }
  }, []);

  /**
   * Connect to conversation:
   * WavRecorder taks speech input, WavStreamPlayer output, client is API client
   */
  const connectConversation = useCallback(async () => {
    const client = clientRef.current;
    const wavStreamPlayer = wavStreamPlayerRef.current;

    // 設置狀態變量
    startTimeRef.current = new Date().toISOString();
    setIsConnected(true);
    setRealtimeEvents([]);
    setItems(client.conversation.getItems());

    // 連接到音頻輸出
    await wavStreamPlayer.connect();

    // 連接到實時 API
    await client.connect();
    client.sendUserMessageContent([
      {
        type: `input_text`,
        text: `Hello!`,
      },
    ]);
  }, []);

  /**
   * Disconnect and reset conversation state
   */
  const disconnectConversation = useCallback(async () => {
    setIsConnected(false);
    setRealtimeEvents([]);
    setItems([]);
    setCoords({
      lat: 37.775593,
      lng: -122.418137,
    });
    setMarker(null);

    const client = clientRef.current;
    const wavStreamPlayer = wavStreamPlayerRef.current;
    client.disconnect();
    await wavStreamPlayer.interrupt();
  }, []);

  const deleteConversationItem = useCallback(async (id: string) => {
    const client = clientRef.current;
    client.deleteItem(id);
  }, []);

  /**
   * Send text message
   */
  const sendTextMessage = useCallback(() => {
    if (!inputText.trim() || !isConnected) return;

    const client = clientRef.current;
    client.sendUserMessageContent([
      {
        type: 'input_text',
        text: inputText,
      },
    ]);
    setInputText('');
  }, [inputText, isConnected]);

  /**
   * Switch between Manual <> VAD mode for communication
   */
  const changeTurnEndType = async (value: string) => {
    const client = clientRef.current;
    client.updateSession({
      turn_detection: value === 'none' ? null : { type: 'server_vad' },
    });
    setCanPushToTalk(value === 'none');
  };

  /**
   * Auto-scroll the event logs
   */
  useEffect(() => {
    if (eventsScrollRef.current) {
      const eventsEl = eventsScrollRef.current;
      const scrollHeight = eventsEl.scrollHeight;
      // Only scroll if height has just changed
      if (scrollHeight !== eventsScrollHeightRef.current) {
        eventsEl.scrollTop = scrollHeight;
        eventsScrollHeightRef.current = scrollHeight;
      }
    }
  }, [realtimeEvents]);

  /**
   * Auto-scroll the conversation logs
   */
  useEffect(() => {
    const conversationEls = [].slice.call(
      document.body.querySelectorAll('[data-conversation-content]')
    );
    for (const el of conversationEls) {
      const conversationEl = el as HTMLDivElement;
      conversationEl.scrollTop = conversationEl.scrollHeight;
    }
  }, [items]);

  // 添加一個新的 ref 來存儲創建的 URL
  const audioUrlsRef = useRef<{ [key: string]: string }>({});

  /**
   * Core RealtimeClient and audio capture setup
   * Set all of our instructions, tools, events and more
   */
  useEffect(() => {
    // Get refs
    const client = clientRef.current;
    const wavStreamPlayer = wavStreamPlayerRef.current;

    // Set instructions
    const instruction = systemInstructionKey === 'custom' 
      ? customSystemInstruction 
      : SYSTEM_INSTRUCTIONS[systemInstructionKey];
    client.updateSession({ instructions: instruction });

    // Set transcription, otherwise we don't get user transcriptions back
    client.updateSession({ input_audio_transcription: { model: 'whisper-1' } });

    // 保留 get_weather 工具
    client.addTool(
      {
        name: 'get_weather',
        description:
          'Retrieves the weather for a given lat, lng coordinate pair. Specify a label for the location.',
        parameters: {
          type: 'object',
          properties: {
            lat: {
              type: 'number',
              description: 'Latitude',
            },
            lng: {
              type: 'number',
              description: 'Longitude',
            },
            location: {
              type: 'string',
              description: 'Name of the location',
            },
          },
          required: ['lat', 'lng', 'location'],
        },
      },
      async ({ lat, lng, location }: { [key: string]: any }) => {
        setMarker({ lat, lng, location });
        setCoords({ lat, lng, location });
        const result = await fetch(
          `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&current=temperature_2m,wind_speed_10m`
        );
        const json = await result.json();
        const temperature = {
          value: json.current.temperature_2m as number,
          units: json.current_units.temperature_2m as string,
        };
        const wind_speed = {
          value: json.current.wind_speed_10m as number,
          units: json.current_units.wind_speed_10m as string,
        };
        setMarker({ lat, lng, location, temperature, wind_speed });
        return json;
      }
    );

    // handle realtime events from client + server for event logging
    client.on('realtime.event', (realtimeEvent: RealtimeEvent) => {
      setRealtimeEvents((realtimeEvents) => {
        const lastEvent = realtimeEvents[realtimeEvents.length - 1];
        if (lastEvent?.event.type === realtimeEvent.event.type) {
          // if we receive multiple events in a row, aggregate them for display purposes
          lastEvent.count = (lastEvent.count || 0) + 1;
          return realtimeEvents.slice(0, -1).concat(lastEvent);
        } else {
          return realtimeEvents.concat(realtimeEvent);
        }
      });
    });
    client.on('error', (event: any) => console.error(event));
    client.on('conversation.updated', async ({ item, delta }: any) => {
      const items = client.conversation.getItems();
      if (delta?.audio) {
        wavStreamPlayer.add16BitPCM(delta.audio, item.id);
      }
      if (item.status === 'completed' && item.formatted.audio?.length) {
        console.log('Received audio data:', item.formatted.audio.length, 'bytes');
        
        // 將接收到的音頻數據轉換為 Int16Array
        const pcmData = new Int16Array(item.formatted.audio.buffer);
        
        // 將 PCM 數據轉換為 WAV
        const wavBlob = pcmToWav(pcmData, 24000); // 假設採樣率為 24000
        
        const audioSrc = URL.createObjectURL(wavBlob);
        
        item.formatted.file = { url: audioSrc };
        console.log('Created audio WAV URL');
        
        // 嘗試預加載音頻
        const audio = new Audio(audioSrc);
        audio.addEventListener('canplaythrough', () => {
          console.log('Audio can play through');
        });
        audio.addEventListener('error', (e) => {
          console.error('Audio preload error:', e);
          const audioElement = e.target as HTMLAudioElement;
          console.log('Audio error code:', audioElement.error?.code);
          console.log('Audio error message:', audioElement.error?.message);
        });
        audio.load();
      }
      setItems(items);
    });
    client.on('conversation.interrupted', async () => {
      const trackSampleOffset = await wavStreamPlayer.interrupt();
      if (trackSampleOffset?.trackId) {
        const { trackId, offset } = trackSampleOffset;
        await client.cancelResponse(trackId, offset);
      }
    });

    setItems(client.conversation.getItems());

    return () => {
      // 清理：撤銷所有創建的 URL
      Object.values(audioUrlsRef.current).forEach(URL.revokeObjectURL);
      audioUrlsRef.current = {};
      // cleanup; resets to defaults
      client.reset();
    };
  }, [systemInstructionKey, customSystemInstruction]);

  /**
   * Update system instruction
   */
  const updateSystemInstruction = useCallback(() => {
    const client = clientRef.current;
    const instruction = systemInstructionKey === 'custom' 
      ? customSystemInstruction 
      : SYSTEM_INSTRUCTIONS[systemInstructionKey];
    if (isConnected) {
      client.updateSession({ instructions: instruction });
    }
  }, [systemInstructionKey, customSystemInstruction, isConnected]);

  // 在 useEffect 中添加這個監聽器
  useEffect(() => {
    updateSystemInstruction();
  }, [systemInstructionKey, customSystemInstruction, updateSystemInstruction]);

  /**
   * Render the application
   */
  return (
    <div data-component="ConsolePage">
      <div className="content-top">
        <div className="content-title">
          <img src="/openai-logomark.svg" />
          <span>realtime console</span>
        </div>
        <div className="content-api-key">
          {!LOCAL_RELAY_SERVER_URL && (
            <Button
              icon={Edit}
              iconPosition="end"
              buttonStyle="flush"
              label={`api key: ${apiKey.slice(0, 3)}...`}
              onClick={() => resetAPIKey()}
            />
          )}
          <Button
            label={isConnected ? 'disconnect' : 'connect'}
            iconPosition={isConnected ? 'end' : 'start'}
            icon={isConnected ? X : Zap}
            buttonStyle={isConnected ? 'regular' : 'action'}
            onClick={
              isConnected ? disconnectConversation : connectConversation
            }
          />
        </div>
      </div>
      <div className="content-main">
        <div className="content-logs">
          <div className="content-block conversation">
            <div className="content-block-title">conversation</div>
            <div className="content-block-body" data-conversation-content>
              {!items.length && `awaiting connection...`}
              {items.map((conversationItem, i) => {
                return (
                  <div className="conversation-item" key={conversationItem.id}>
                    <div className={`speaker ${conversationItem.role || ''}`}>
                      <div>
                        {(
                          conversationItem.role || conversationItem.type
                        ).replaceAll('_', ' ')}
                      </div>
                      <div
                        className="close"
                        onClick={() =>
                          deleteConversationItem(conversationItem.id)
                        }
                      >
                        <X />
                      </div>
                    </div>
                    <div className={`speaker-content`}>
                      {/* tool response */}
                      {conversationItem.type === 'function_call_output' && (
                        <div>{conversationItem.formatted.output}</div>
                      )}
                      {/* tool call */}
                      {!!conversationItem.formatted.tool && (
                        <div>
                          {conversationItem.formatted.tool.name}(
                          {conversationItem.formatted.tool.arguments})
                        </div>
                      )}
                      {!conversationItem.formatted.tool &&
                        conversationItem.role === 'user' && (
                          <div>
                            {conversationItem.formatted.transcript ||
                              (conversationItem.formatted.audio?.length
                                ? '(awaiting transcript)'
                                : conversationItem.formatted.text ||
                                  '(item sent)')}
                          </div>
                        )}
                      {!conversationItem.formatted.tool &&
                        conversationItem.role === 'assistant' && (
                          <div>
                            {conversationItem.formatted.transcript ||
                              conversationItem.formatted.text ||
                              '(truncated)'}
                          </div>
                        )}
                      {conversationItem.formatted.file && (
                        <audio
                          src={conversationItem.formatted.file.url}
                          controls
                          onError={(e) => {
                            console.error('Audio playback error:', e);
                            const audioElement = e.target as HTMLAudioElement;
                            console.log('Audio error code:', audioElement.error?.code);
                            console.log('Audio error message:', audioElement.error?.message);
                          }}
                          onLoadedMetadata={() => console.log('Audio metadata loaded')}
                          onCanPlay={() => console.log('Audio can play')}
                        />
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
        <div className="content-right">
          <div className="content-block system-instruction">
            <div className="content-block-title">System Instruction</div>
            <div className="content-block-body">
              <select 
                value={systemInstructionKey}
                onChange={(e) => setSystemInstructionKey(e.target.value as keyof typeof SYSTEM_INSTRUCTIONS)}
              >
                {Object.keys(SYSTEM_INSTRUCTIONS).map((key) => (
                  <option key={key} value={key}>
                    {key.charAt(0).toUpperCase() + key.slice(1)}
                  </option>
                ))}
                <option value="custom">Custom</option>
              </select>
              {systemInstructionKey === 'custom' && (
                <textarea
                  value={customSystemInstruction}
                  onChange={(e) => setCustomSystemInstruction(e.target.value)}
                  placeholder="Enter custom system instruction here..."
                />
              )}
              {/* 添加一個顯示當前系統指令的文本區域 */}
              <textarea
                value={systemInstructionKey === 'custom' 
                  ? customSystemInstruction 
                  : SYSTEM_INSTRUCTIONS[systemInstructionKey]}
                readOnly
                placeholder="Current system instruction"
              />
            </div>
          </div>
          <div className="content-block debug-console">
            <div className="content-block-title">Debug Console</div>
            <div className="content-block-body content-debug">
              {realtimeEvents.map((realtimeEvent, i) => {
                const count = realtimeEvent.count;
                const event = { ...realtimeEvent.event };
                if (event.type === 'input_audio_buffer.append') {
                  event.audio = `[trimmed: ${event.audio.length} bytes]`;
                } else if (event.type === 'response.audio.delta') {
                  event.delta = `[trimmed: ${event.delta.length} bytes]`;
                }
                return (
                  <div className="event" key={event.event_id}>
                    <div className="event-timestamp">
                      {formatTime(realtimeEvent.time)}
                    </div>
                    <div className="event-details">
                      <div className="event-summary">
                        <div className={`event-source ${event.type === 'error' ? 'error' : realtimeEvent.source}`}>
                          {realtimeEvent.source === 'client' ? <ArrowUp /> : <ArrowDown />}
                          <span>{event.type === 'error' ? 'error!' : realtimeEvent.source}</span>
                        </div>
                        <div className="event-type">
                          {event.type}
                          {count && ` (${count})`}
                        </div>
                      </div>
                      {!!expandedEvents[event.event_id] && (
                        <div className="event-payload">
                          {JSON.stringify(event, null, 2)}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
      <div className="content-bottom">
        <div className="content-actions">
          <input
            type="text"
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            onKeyPress={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                sendTextMessage();
              }
            }}
            placeholder="Type your message..."
            disabled={!isConnected}
          />
          <Button
            label="Send"
            onClick={sendTextMessage}
            disabled={!isConnected || !inputText.trim()}
          />
        </div>
      </div>
    </div>
  );
}