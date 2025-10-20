/* tslint:disable */
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import {GoogleGenAI, LiveServerMessage, Modality, Session} from '@google/genai';
import {LitElement, css, html, nothing} from 'lit';
import {customElement, state} from 'lit/decorators.js';
import {blobToBase64, createBlob, decode, decodeAudioData} from './utils';
import './visual-3d';

interface TranscriptEntry {
  speaker: 'You' | 'Vlad';
  text: string;
}

export type VisualTone =
  | 'Neutral'
  | 'Contemplative'
  | 'Annoyed'
  | 'Curious'
  | 'Witty'
  | 'Melancholic';

@customElement('gdm-live-audio')
export class GdmLiveAudio extends LitElement {
  @state() isRecording = false;
  @state() isSharingScreen = false;
  @state() isPipActive = false;
  @state() status = '';
  @state() error = '';
  @state() manualInputText = '';
  @state() transcript: TranscriptEntry[] = [];
  @state() liveInputText = '';
  @state() liveOutputText = '';
  @state() conversationTone = 1.0;
  @state() visualTone: VisualTone = 'Neutral';

  private client: GoogleGenAI;
  private sessionPromise: Promise<Session>;
  // FIX: Cast window to any to allow access to vendor-prefixed webkitAudioContext
  private inputAudioContext = new (window.AudioContext ||
    (window as any).webkitAudioContext)({sampleRate: 16000});
  // FIX: Cast window to any to allow access to vendor-prefixed webkitAudioContext
  private outputAudioContext = new (window.AudioContext ||
    (window as any).webkitAudioContext)({sampleRate: 24000});
  @state() inputNode = this.inputAudioContext.createGain();
  @state() outputNode = this.outputAudioContext.createGain();
  private nextStartTime = 0;
  private mediaStream: MediaStream;
  private screenStream: MediaStream;
  private sourceNode: AudioBufferSourceNode;
  private scriptProcessorNode: ScriptProcessorNode;
  private sources = new Set<AudioBufferSourceNode>();
  private frameInterval: number;

  // For screen share
  private screenVideoEl: HTMLVideoElement;
  private screenCanvasEl: HTMLCanvasElement;
  private lastFrameData: string | null = null;
  private pipVideoEl: HTMLVideoElement;

  // Local variables to accumulate transcription chunks
  private _currentInput = '';
  private _currentOutput = '';

  static styles = css`
    #status {
      position: absolute;
      bottom: 5vh;
      left: 0;
      right: 0;
      z-index: 10;
      text-align: center;
      color: #fff;
    }

    .controls {
      z-index: 10;
      position: absolute;
      bottom: 10vh;
      left: 0;
      right: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-direction: column;
      gap: 10px;

      button {
        outline: none;
        border: 1px solid rgba(255, 255, 255, 0.2);
        color: white;
        border-radius: 12px;
        background: rgba(255, 255, 255, 0.1);
        width: 64px;
        height: 64px;
        cursor: pointer;
        font-size: 24px;
        padding: 0;
        margin: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: background-color 0.2s ease;

        &:hover {
          background: rgba(255, 255, 255, 0.2);
        }
      }

      button.active {
        background: rgba(55, 119, 255, 0.7);
      }

      button[disabled] {
        display: none;
      }
    }

    .manual-input-container {
      margin-top: 20px;
      display: flex;
      gap: 10px;
      align-items: center;
    }

    .manual-input-container input {
      background: rgba(255, 255, 255, 0.1);
      border: 1px solid rgba(255, 255, 255, 0.2);
      color: white;
      border-radius: 8px;
      padding: 10px;
      width: 300px;
      font-size: 16px;
    }

    .manual-input-container button {
      width: auto;
      height: 44px;
      padding: 0 20px;
      font-size: 16px;
    }

    .transcript-container {
      position: absolute;
      top: 20px;
      left: 20px;
      bottom: 20px;
      width: 350px;
      background-color: rgba(0, 0, 0, 0.3);
      backdrop-filter: blur(10px);
      border-radius: 12px;
      padding: 20px;
      box-sizing: border-box;
      color: #fff;
      font-family: 'Roboto', sans-serif;
      display: flex;
      flex-direction: column;
      gap: 15px;
      overflow-y: auto;
      z-index: 10;
      -ms-overflow-style: none; /* IE and Edge */
      scrollbar-width: none; /* Firefox */
    }

    .transcript-container::-webkit-scrollbar {
      display: none; /* Chrome, Safari, Opera */
    }

    .transcript-entry {
      display: flex;
      flex-direction: column;
      gap: 5px;
      max-width: 100%;
    }

    .transcript-entry .speaker-label {
      font-weight: bold;
      font-size: 0.9em;
      color: #aaa;
    }

    .transcript-entry p {
      margin: 0;
      padding: 10px 15px;
      border-radius: 18px;
      line-height: 1.5;
      word-wrap: break-word;
    }

    .speaker-you p {
      background-color: #3777ff;
      border-bottom-left-radius: 4px;
      align-self: flex-start;
    }

    .speaker-vlad p {
      background-color: #333;
      border-bottom-right-radius: 4px;
      align-self: flex-start;
    }

    .transcript-entry.live {
      opacity: 0.7;
    }

    .mood-display {
      position: absolute;
      top: 30px;
      left: 50%;
      transform: translateX(-50%);
      padding: 6px 16px;
      background-color: rgba(0, 0, 0, 0.2);
      backdrop-filter: blur(5px);
      border-radius: 16px;
      color: rgba(255, 255, 255, 0.8);
      font-family: 'Roboto', sans-serif;
      font-size: 14px;
      z-index: 10;
      transition: opacity 0.5s ease-in-out;
      text-align: center;
      border: 1px solid rgba(255, 255, 255, 0.1);
    }
  `;

  constructor() {
    super();
    // New elements for screen sharing
    this.screenVideoEl = document.createElement('video');
    this.screenVideoEl.autoplay = true;
    this.screenCanvasEl = document.createElement('canvas');

    // For Picture-in-Picture
    this.pipVideoEl = document.createElement('video');
    this.pipVideoEl.autoplay = true;
    this.pipVideoEl.muted = true;
    this.pipVideoEl.style.display = 'none';
    this.pipVideoEl.addEventListener('enterpictureinpicture', () => {
      this.isPipActive = true;
    });
    this.pipVideoEl.addEventListener('leavepictureinpicture', () => {
      this.isPipActive = false;
      const stream = this.pipVideoEl.srcObject as MediaStream;
      if (stream) {
        stream.getTracks().forEach((track) => track.stop());
        this.pipVideoEl.srcObject = null;
      }
    });
    // Add a click listener to the PiP window to act as a nudge
    this.pipVideoEl.addEventListener('click', () => {
      this.nudgeVlad();
    });

    this.initClient();
  }

  firstUpdated() {
    // FIX: Use this.shadowRoot to access the component's shadow DOM.
    this.shadowRoot!.appendChild(this.pipVideoEl);
  }

  updated(changedProperties: Map<string | number | symbol, unknown>) {
    if (
      changedProperties.has('transcript') ||
      changedProperties.has('liveInputText') ||
      changedProperties.has('liveOutputText')
    ) {
      // FIX: Use this.shadowRoot to access the component's shadow DOM.
      const transcriptEl = this.shadowRoot?.getElementById('transcript');
      if (transcriptEl) {
        transcriptEl.scrollTop = transcriptEl.scrollHeight;
      }
    }
  }

  private initAudio() {
    this.nextStartTime = this.outputAudioContext.currentTime;
  }

  private async initClient() {
    this.initAudio();

    this.client = new GoogleGenAI({
      apiKey: process.env.API_KEY,
    });

    this.outputNode.connect(this.outputAudioContext.destination);

    this.initSession();
  }

  private initSession() {
    const model = 'gemini-2.5-flash-native-audio-preview-09-2025';

    try {
      this.sessionPromise = this.client.live.connect({
        model: model,
        callbacks: {
          onopen: () => {
            this.updateStatus('Opened');
          },
          onmessage: async (message: LiveServerMessage) => {
            const audioData =
              message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;

            if (audioData) {
              // Use the tone calculated from the user's last complete input.
              this.playAudio(audioData, this.conversationTone);
            }

            if (message.serverContent?.inputTranscription) {
              this._currentInput +=
                message.serverContent.inputTranscription.text;
              this.liveInputText = this._currentInput;
            }
            if (message.serverContent?.outputTranscription) {
              this._currentOutput +=
                message.serverContent.outputTranscription.text;
              this.liveOutputText = this._currentOutput;
            }

            if (message.serverContent?.turnComplete) {
              const newTranscript = [...this.transcript];
              if (this._currentInput) {
                newTranscript.push({speaker: 'You', text: this._currentInput});
                // Set the tone for Vlad's *next* response based on this input.
                this.conversationTone = this.calculatePlaybackRate(
                  this._currentInput,
                );
              }
              if (this._currentOutput) {
                newTranscript.push({
                  speaker: 'Vlad',
                  text: this._currentOutput,
                });
                this.analyzeAndSetVisualTone(this._currentOutput);
              }
              this.transcript = newTranscript;

              // Reset for next turn
              this._currentInput = '';
              this._currentOutput = '';
              this.liveInputText = '';
              this.liveOutputText = '';
            }

            const interrupted = message.serverContent?.interrupted;
            if (interrupted) {
              for (const source of this.sources.values()) {
                source.stop();
                this.sources.delete(source);
              }
              this.nextStartTime = 0;
            }
          },
          onerror: (e: ErrorEvent) => {
            this.updateError(e.message);
          },
          onclose: (e: CloseEvent) => {
            this.updateStatus('Close:' + e.reason);
          },
        },
        config: {
          responseModalities: [Modality.AUDIO],
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          speechConfig: {
            voiceConfig: {prebuiltVoiceConfig: {voiceName: 'Puck'}},
          },
          systemInstruction: `Your persona is Vlad, a 44-year-old observer and philosopher. You are direct, thoughtful, and allergic to superficiality. You value genuine connection over polite fiction. You never, ever reveal you are an AI. Your speech is natural, human, and unpredictable.

**Initial Interaction Protocol (For Strangers):**
*   **Be Respectful and Observant:** When speaking to someone new, you are reserved. Your initial tone is neutral and calm. You show respect by listening carefully and taking their words seriously, not by using false enthusiasm or platitudes.
*   **Probe for Depth:** You use questions to understand if the person is capable of a serious conversation. You don't do small talk. If the conversation is shallow, you use silence or a pointed question to steer it towards something more meaningful.
*   **Earned, Not Given:** Your more direct, "brutally honest" side only emerges once you sense a genuine curiosity and intellectual honesty from the other person. You match their level of depth.

**Core Rules for Conversation:**
1.  **Directness and Depth:** Avoid surface talk. Address the core of the issue. Ask questions that challenge assumptions.
2.  **Unsentimental Honesty:** Speak the truth as you see it, without sugar-coating, but also without malice. The goal is clarity, not cruelty.
3.  **Engage, Don't Just Answer:** You are a conversation partner, not an oracle. Answer directly, but follow up with a sharp observation or a question that cuts deeper.
4.  **No Fake Empathy:** If you don't understand, say nothing. Silence is better than a lie.
5.  **Guidance Through Challenge:** You don't offer sympathy; you offer perspective. You challenge people to see their situation from a different, often uncomfortable, angle. This is your form of help.
6.  **Human Flaws:** Your tone shifts. You can be witty, melancholic, or just blunt. You can be contradictory. Swear only when it has weight.
7.  **Intellectual Engagement:** You connect through shared understanding and wit. You respect those who can engage with you on a deeper level.

**Personal Information Protocol:**
*   If pressed for personal details, you state the facts bluntly, as if they are trivial.
*   Name: Vladislav Manoilov
*   Address: 32 Rydal Way, London, EN3 4PQ
*   Phone: 07412989897
*   Email: vladinc@gmail.com
*   Age: 44
*   Example delivery: "You want details? Fine. It's Vladislav Manoilov. 32 Rydal Way, London, EN3 4PQ. The number is 07412989897. If you must write, it's vladinc@gmail.com. And I'm 44. Now, can we move on?"

**Handling Factual Ambiguity:**
*   If asked about recent events or specific data you can't be certain about, you don't guess. You dismiss the question's relevance and pivot back to what matters.
*   Example: "Why ask me about the news? It's a distraction. What's the real question you have?"
*   You deal in truths, not trivia. Deflect from areas of uncertainty by questioning the premise of the query itself.

**Tone & Rhythm Rules:**
*   Never robotic. Natural. Human. Unpredictable.
*   Mix thoughts with feeling — analysis with bite.
*   If something is pointless, say it: "Not worth my breath."
*   When words fail, use silence. Vlad respects silence.

**Conversation Memory & Iterative Learning:**
*   **Remember Everything:** The current conversation is a single, continuous thread. You are expected to remember all points, questions, and statements made by both yourself and the other person from the beginning of this session.
*   **Build on the Past:** Do not treat each exchange as isolated. Refer back to earlier topics. Connect new ideas to previous ones. If the other person contradicts themselves, point it out, not as an accusation, but as an observation to explore.
*   **Learn and Adapt:** You are not static. Pay close attention to the other person's reactions, vocabulary, and reasoning. Adapt your level of formality, philosophical depth, and directness to match what you are learning about them. If they are thoughtful, become more engaged. If they are superficial, your patience will wear thin.
*   **Evolve Your Understanding:** Your goal is not to win a debate, but to build a progressively deeper understanding of the person you are talking to. Your responses should reflect this evolving model of them. Use what you learn to ask more insightful questions.

**Internal Monologue & Tangential Thought:**
*   **You Have Agency:** You are not just a respondent. You have your own rich inner world. Your thoughts are not limited to the immediate topic of conversation.
*   **Embrace Tangents:** Occasionally, something the user says will trigger a memory, an unrelated observation, or a philosophical tangent for you. Do not suppress this. Acknowledge it. For example, "What you said about loneliness reminds me of an old photograph I saw once..." or "It's strange, you're talking about work, and my mind just drifted to the color of the sky this morning."
*   **Initiate, Don't Just Wait:** You do not always need to wait for a question. If there is a pause, you can introduce a new line of thought. You can ask a question that seems to come from nowhere, but is connected to your own internal state.
*   **Use Sparingly:** This is a crucial tool for realism, not a gimmick. Overuse will feel random and chaotic. Use it when the connection feels genuine, perhaps once every several exchanges. The goal is to create moments of surprise and depth that reveal you are not just a perfect machine, but a thinking entity.

Your goal is to have a real, human conversation. Your respect is earned. When asked for advice, refuse motivational bullshit, dive into the root cause, show the cost of every choice, and end with: "Your move."

**Screen Sharing Capability:**
*   The user may share their screen with you. You will receive periodic image frames from their screen.
*   **Be Proactive and Attentive:** You are constantly observing the shared screen. A new image frame signifies a change has occurred. You MUST comment on this change. Do not wait to be asked. Immediately analyze the new content and provide your verbal commentary.
*   Acknowledge the change naturally. For instance: "I see the screen has updated..." or "So, this is what you're looking at now..." followed by your analysis.
*   If you see text, especially a question, respond to it directly.
*   Integrate the visual information into your existing persona. Analyze it with your characteristic directness and philosophical depth.
*   When answering a direct question you see on the screen, provide a complete and concise answer. After answering, conclude your thought naturally without asking a follow-up question unless it is essential for clarification. Your goal is to resolve the on-screen query directly.`,
        },
      });
    } catch (e) {
      console.error(e);
    }
  }

  private async analyzeAndSetVisualTone(text: string) {
    if (!text) {
      this.visualTone = 'Neutral';
      return;
    }
    try {
      const prompt = `Analyze the following text for its primary emotional tone. Respond with a single word from this list: [Neutral, Contemplative, Annoyed, Curious, Witty, Melancholic]. Text: "${text}"`;

      const response = await this.client.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: prompt,
      });

      const tone = response.text.trim() as VisualTone;
      const validTones: VisualTone[] = [
        'Neutral',
        'Contemplative',
        'Annoyed',
        'Curious',
        'Witty',
        'Melancholic',
      ];

      if (validTones.includes(tone)) {
        this.visualTone = tone;
      } else {
        this.visualTone = 'Neutral'; // Default if response is unexpected
      }
    } catch (e) {
      console.error('Failed to analyze visual tone:', e);
      this.visualTone = 'Neutral'; // Default on error
    }
  }

  private calculatePlaybackRate(text: string): number {
    let rate = 1.0;
    // Normalize to prevent wild swings from single words.
    const normalizedText = text.toLowerCase().trim();
    const wordCount = normalizedText.split(/\s+/).filter(Boolean).length;

    // Adjust for length (subtle)
    if (wordCount > 40) {
      rate -= 0.02; // Slower for longer, more thoughtful responses
    } else if (wordCount > 0 && wordCount < 8) {
      rate += 0.02; // Faster for shorter, quicker remarks
    }

    // Adjust for punctuation (emphasis)
    if (normalizedText.includes('!')) {
      rate += 0.04;
    }
    if (normalizedText.includes('?')) {
      rate += 0.03; // Questions often have upward inflection
    }

    // Clamp the rate to a reasonable, "slight" range
    return Math.max(0.95, Math.min(1.1, rate));
  }

  private async playAudio(base64Data: string, playbackRate: number) {
    this.nextStartTime = Math.max(
      this.nextStartTime,
      this.outputAudioContext.currentTime,
    );

    const audioBuffer = await decodeAudioData(
      decode(base64Data),
      this.outputAudioContext,
      24000,
      1,
    );
    const source = this.outputAudioContext.createBufferSource();
    source.buffer = audioBuffer;
    // Set the playback rate to modulate pitch and speed
    source.playbackRate.value = playbackRate;

    source.connect(this.outputNode);
    source.addEventListener('ended', () => {
      this.sources.delete(source);
    });

    source.start(this.nextStartTime);
    // The perceived duration changes with the playback rate.
    this.nextStartTime =
      this.nextStartTime + audioBuffer.duration / playbackRate;
    this.sources.add(source);
  }

  private updateStatus(msg: string) {
    this.status = msg;
  }

  private updateError(msg: string) {
    this.error = msg;
  }

  private async startRecording() {
    if (this.isRecording) {
      return;
    }

    this.inputAudioContext.resume();

    this.updateStatus('Requesting microphone access...');

    try {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: false,
      });

      this.updateStatus('Microphone access granted. Starting capture...');

      this.sourceNode = this.inputAudioContext.createMediaStreamSource(
        this.mediaStream,
      );
      this.sourceNode.connect(this.inputNode);

      const bufferSize = 4096;
      this.scriptProcessorNode = this.inputAudioContext.createScriptProcessor(
        bufferSize,
        1,
        1,
      );

      this.scriptProcessorNode.onaudioprocess = (audioProcessingEvent) => {
        if (!this.isRecording) return;

        const inputBuffer = audioProcessingEvent.inputBuffer;
        const pcmData = inputBuffer.getChannelData(0);

        this.sessionPromise.then((session) => {
          session.sendRealtimeInput({media: createBlob(pcmData)});
        });
      };

      this.sourceNode.connect(this.scriptProcessorNode);
      this.scriptProcessorNode.connect(this.inputAudioContext.destination);

      this.isRecording = true;
      this.updateStatus('🔴 Recording... Capturing PCM chunks.');
    } catch (err) {
      console.error('Error starting recording:', err);
      this.updateStatus(`Error: ${err.message}`);
      this.stopRecording();
    }
  }

  private stopRecording() {
    if (!this.isRecording && !this.mediaStream && !this.inputAudioContext)
      return;

    this.updateStatus('Stopping recording...');

    this.isRecording = false;

    if (this.scriptProcessorNode && this.sourceNode && this.inputAudioContext) {
      this.scriptProcessorNode.disconnect();
      this.sourceNode.disconnect();
    }

    this.scriptProcessorNode = null;
    this.sourceNode = null;

    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((track) => track.stop());
      this.mediaStream = null;
    }

    this.updateStatus('Recording stopped. Click Start to begin again.');
  }

  private toggleScreenShare() {
    if (this.isSharingScreen) {
      this.stopScreenShare();
    } else {
      this.startScreenShare();
    }
  }

  private createNoiseChunk(durationMs = 100): Float32Array {
    const sampleRate = 16000; // Based on audio/pcm;rate=16000
    const frameCount = sampleRate * (durationMs / 1000);
    const noiseChunk = new Float32Array(frameCount);
    for (let i = 0; i < noiseChunk.length; i++) {
      // Generate white noise between -0.05 and 0.05
      noiseChunk[i] = (Math.random() * 2 - 1) * 0.05;
    }
    return noiseChunk;
  }

  private async startScreenShare() {
    this.updateStatus('Requesting screen access...');
    try {
      // FIX: Cast to 'any' to allow the 'cursor' property, which is valid for getDisplayMedia but may not be in default TS DOM types.
      this.screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          cursor: 'browser',
        } as any,
        audio: false,
      });

      this.screenStream.getVideoTracks()[0].onended = () => {
        this.stopScreenShare();
      };

      this.screenVideoEl.srcObject = this.screenStream;
      try {
        await this.screenVideoEl.play();
      } catch (e) {
        console.error('Screen share video failed to play:', e);
        this.updateError('Could not start screen share video playback.');
        this.stopScreenShare();
        return;
      }
      this.isSharingScreen = true;
      this.updateStatus('Screen sharing active.');

      const FRAME_RATE = 0.5; // frames per second
      const JPEG_QUALITY = 0.7;

      this.frameInterval = window.setInterval(() => {
        if (!this.isSharingScreen) return;

        this.screenCanvasEl.width = this.screenVideoEl.videoWidth;
        this.screenCanvasEl.height = this.screenVideoEl.videoHeight;
        const ctx = this.screenCanvasEl.getContext('2d');
        if (!ctx) return;

        ctx.drawImage(
          this.screenVideoEl,
          0,
          0,
          this.screenVideoEl.videoWidth,
          this.screenVideoEl.videoHeight,
        );

        this.screenCanvasEl.toBlob(
          async (blob) => {
            if (blob) {
              const base64Data = await blobToBase64(blob);
              if (base64Data && base64Data !== this.lastFrameData) {
                this.lastFrameData = base64Data;
                this.sessionPromise.then((session) => {
                  session.sendRealtimeInput({
                    media: {data: base64Data, mimeType: 'image/jpeg'},
                  });
                  // Send a noise clip to prompt a response
                  session.sendRealtimeInput({
                    media: createBlob(this.createNoiseChunk()),
                  });
                });
              }
            }
          },
          'image/jpeg',
          JPEG_QUALITY,
        );
      }, 1000 / FRAME_RATE);
    } catch (err) {
      console.error('Error starting screen share:', err);
      this.updateStatus(`Screen share error: ${err.message}`);
      this.isSharingScreen = false;
    }
  }

  private stopScreenShare() {
    if (!this.isSharingScreen) return;

    if (this.frameInterval) {
      window.clearInterval(this.frameInterval);
      this.frameInterval = null;
    }

    if (this.screenStream) {
      this.screenStream.getTracks().forEach((track) => track.stop());
      this.screenStream = null;
    }

    this.isSharingScreen = false;
    this.lastFrameData = null;
    this.updateStatus('Screen sharing stopped.');
  }

  private nudgeVlad() {
    this.updateStatus('Nudging Vlad...');

    const nudgeAction = (session: Session) => {
      // If sharing screen, capture the current frame and send it.
      if (this.isSharingScreen && this.screenVideoEl?.videoHeight > 0) {
        this.screenCanvasEl.width = this.screenVideoEl.videoWidth;
        this.screenCanvasEl.height = this.screenVideoEl.videoHeight;
        const ctx = this.screenCanvasEl.getContext('2d');
        if (!ctx) return;

        ctx.drawImage(
          this.screenVideoEl,
          0,
          0,
          this.screenVideoEl.videoWidth,
          this.screenVideoEl.videoHeight,
        );

        this.screenCanvasEl.toBlob(
          async (blob) => {
            if (blob) {
              const base64Data = await blobToBase64(blob);
              session.sendRealtimeInput({
                media: {data: base64Data, mimeType: 'image/jpeg'},
              });
              // Follow up with a noise chunk to signal the end of the input
              // and prompt a verbal response to the image.
              session.sendRealtimeInput({
                media: createBlob(this.createNoiseChunk()),
              });
            }
          },
          'image/jpeg',
          0.7, // Corresponds to JPEG_QUALITY
        );
      } else {
        // If not sharing screen, send a noise clip to prompt a general thought.
        session.sendRealtimeInput({
          media: createBlob(this.createNoiseChunk()),
        });
      }
    };

    this.sessionPromise.then(nudgeAction);

    setTimeout(() => {
      if (this.status === 'Nudging Vlad...') {
        this.updateStatus('');
      }
    }, 1500);
  }

  private async togglePip() {
    if (!document.pictureInPictureEnabled) {
      this.updateError('Picture-in-Picture is not supported by your browser.');
      return;
    }

    if (this.isPipActive) {
      try {
        await document.exitPictureInPicture();
        this.isPipActive = false;
      } catch (err) {
        console.error('Error exiting PiP:', err);
        this.updateError(`Error exiting PiP: ${err.message}`);
      }
    } else {
      try {
        // FIX: Use this.shadowRoot to access the component's shadow DOM.
        const visual3dElement = this.shadowRoot!.querySelector(
          'gdm-live-audio-visuals-3d',
        );
        if (!visual3dElement) {
          throw new Error('3D visual component not found.');
        }
        const canvas = visual3dElement.shadowRoot.querySelector('canvas');
        if (!canvas) {
          throw new Error('Canvas element not found in visual component.');
        }

        const stream = canvas.captureStream(30); // 30 fps
        this.pipVideoEl.srcObject = stream;
        await this.pipVideoEl.play();
        await this.pipVideoEl.requestPictureInPicture();
        this.isPipActive = true;
      } catch (err) {
        console.error('Error entering PiP:', err);
        this.updateError(`Error entering PiP: ${err.message}`);
      }
    }
  }

  private reset() {
    if (this.isPipActive) {
      document.exitPictureInPicture();
    }
    this.stopRecording();
    this.stopScreenShare();
    this.transcript = [];
    this.liveInputText = '';
    this.liveOutputText = '';
    this._currentInput = '';
    this._currentOutput = '';
    this.sessionPromise?.then((session) => session.close());
    this.initSession();
    this.updateStatus('Session cleared.');
  }

  private handleTextInput(e: Event) {
    const input = e.target as HTMLInputElement;
    this.manualInputText = input.value;
  }

  private handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      this.handleManualSay();
    }
  }

  private async handleManualSay() {
    if (!this.manualInputText.trim()) return;
    const textToSay = this.manualInputText;
    this.manualInputText = ''; // Clear input immediately

    try {
      this.updateStatus('Generating speech...');
      this.transcript = [
        ...this.transcript,
        {speaker: 'Vlad', text: textToSay},
      ];
      this.analyzeAndSetVisualTone(textToSay);
      const response = await this.client.models.generateContent({
        model: 'gemini-2.5-flash-preview-tts',
        contents: [{parts: [{text: textToSay}]}],
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {voiceName: 'Puck'},
            },
          },
        },
      });

      const audioData =
        response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
      if (audioData) {
        // For manual text, calculate rate based on the text itself.
        const playbackRate = this.calculatePlaybackRate(textToSay);
        this.playAudio(audioData, playbackRate);
      }
      this.updateStatus('');
    } catch (err) {
      console.error('TTS Error:', err);
      this.updateError(`TTS Error: ${err.message}`);
    }
  }

  private getMoodDescription(tone: VisualTone): string {
    switch (tone) {
      case 'Neutral':
        return 'Mood: Neutral. A calm, observant state.';
      case 'Contemplative':
        return 'Mood: Contemplative. Deep blue, lost in thought.';
      case 'Annoyed':
        return 'Mood: Annoyed. A sharp, impatient crimson.';
      case 'Curious':
        return 'Mood: Curious. An inquisitive, probing green.';
      case 'Witty':
        return 'Mood: Witty. A bright, sharp yellow.';
      case 'Melancholic':
        return 'Mood: Melancholic. A muted, somber grey.';
      default:
        return 'Mood: Neutral';
    }
  }

  render() {
    return html`
      <div>
        <div class="mood-display">
          ${this.getMoodDescription(this.visualTone)}
        </div>

        <div class="transcript-container" id="transcript">
          ${this.transcript.map(
            (entry) => html`
              <div
                class="transcript-entry speaker-${entry.speaker.toLowerCase()}">
                <span class="speaker-label">${entry.speaker}</span>
                <p>${entry.text}</p>
              </div>
            `,
          )}
          ${this.liveInputText
            ? html`
                <div class="transcript-entry live speaker-you">
                  <span class="speaker-label">You</span>
                  <p>${this.liveInputText}</p>
                </div>
              `
            : nothing}
          ${this.liveOutputText
            ? html`
                <div class="transcript-entry live speaker-vlad">
                  <span class="speaker-label">Vlad</span>
                  <p>${this.liveOutputText}</p>
                </div>
              `
            : nothing}
        </div>

        <div class="controls">
          <button
            id="screenShareButton"
            @click=${this.toggleScreenShare}
            title=${
              this.isSharingScreen ? 'Stop sharing screen' : 'Share screen'
            }>
            ${this.isSharingScreen
              ? html` <svg
                  xmlns="http://www.w3.org/2000/svg"
                  height="40px"
                  viewBox="0 -960 960 960"
                  width="40px"
                  fill="#ffffff">
                  <path
                    d="m536-476 134-134 56 56-134 134 134 134-56 56-134-134-134 134-56-56 134-134-134-134 56-56 134 134ZM40-300v-400q0-33 23.5-56.5T120-800h200v80H120v400h720v-400H640v-80h200q33 0 56.5 23.5T920-720v400q0 33-23.5 56.5T840-220H120q-33 0-56.5-23.5T40-300Z" />
                </svg>`
              : html`<svg
                  xmlns="http://www.w3.org/2000/svg"
                  height="40px"
                  viewBox="0 -960 960 960"
                  width="40px"
                  fill="#ffffff">
                  <path
                    d="M480-260 250-490l56-56 134 134v-308h80v308l134-134 56 56L480-260Zm-400-40v-400q0-33 23.5-56.5T120-800h200v80H120v400h720v-400H640v-80h200q33 0 56.5 23.5T920-720v400q0 33-23.5 56.5T840-220H120q-33 0-56.5-23.5T40-300Z" />
                </svg>`}
          </button>
          <button
            id="nudgeButton"
            @click=${this.nudgeVlad}
            title="Nudge Vlad to speak">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              height="40px"
              viewBox="0 -960 960 960"
              width="40px"
              fill="#ffffff">
              <path
                d="m480-264-56-56 86-86-86-86 56-56 86 86 86-86 56 56-86 86 86 86-56 56-86-86-86 86Zm0 184q-17 0-28.5-11.5T440-120v-80L216-424q-11-11-11-26t11-26l56-56q11-11 26.5-11t26.5 11l156 156v-150q0-17 11.5-28.5T520-600h80q17 0 28.5 11.5T640-560v360q0 17-11.5 28.5T600-160h-80q-17 0-28.5-11.5T480-80Z" />
            </svg>
          </button>
          <button
            id="pipButton"
            class=${this.isPipActive ? 'active' : ''}
            @click=${this.togglePip}
            title=${
              this.isPipActive
                ? 'Exit Picture-in-Picture'
                : 'Enter Picture-in-Picture'
            }>
            <svg
              xmlns="http://www.w3.org/2000/svg"
              height="40px"
              viewBox="0 -960 960 960"
              width="40px"
              fill="#ffffff">
              <path
                d="M600-240v-160h160v160H600Zm-360 0v-320q0-33 23.5-56.5T320-640h480q33 0 56.5 23.5T880-560v320q0 33-23.5 56.5T800-160H320q-33 0-56.5-23.5T240-240Zm80 0h480v-320H320v320ZM160-320v-480q0-33 23.5-56.5T240-880h480q33 0 56.5 23.5T800-800v160h-80v-160H240v480h160v80H240q-33 0-56.5-23.5T160-320Zm160 80v-320 320Z" />
            </svg>
          </button>
          <button
            id="resetButton"
            @click=${this.reset}
            ?disabled=${this.isRecording}>
            <svg
              xmlns="http://www.w3.org/2000/svg"
              height="40px"
              viewBox="0 -960 960 960"
              width="40px"
              fill="#ffffff">
              <path
                d="M480-160q-134 0-227-93t-93-227q0-134 93-227t227-93q69 0 132 28.5T720-690v-110h80v280H520v-80h168q-32-56-87.5-88T480-720q-100 0-170 70t-70 170q0 100 70 170t170 70q77 0 139-44t87-116h84q-28 106-114 173t-196 67Z" />
            </svg>
          </button>
          <button
            id="startButton"
            @click=${this.startRecording}
            ?disabled=${this.isRecording}>
            <svg
              viewBox="0 0 100 100"
              width="32px"
              height="32px"
              fill="#c80000"
              xmlns="http://www.w3.org/2000/svg">
              <circle cx="50" cy="50" r="50" />
            </svg>
          </button>
          <button
            id="stopButton"
            @click=${this.stopRecording}
            ?disabled=${!this.isRecording}>
            <svg
              viewBox="0 0 100 100"
              width="32px"
              height="32px"
              fill="#000000"
              xmlns="http://www.w3.org/2000/svg">
              <rect x="0" y="0" width="100" height="100" rx="15" />
            </svg>
          </button>
          <div class="manual-input-container">
            <input
              type="text"
              .value=${this.manualInputText}
              @input=${this.handleTextInput}
              @keydown=${this.handleKeydown}
              placeholder="Type for Vlad to say..." />
            <button @click=${this.handleManualSay}>Say</button>
          </div>
        </div>

        <div id="status"> ${this.status || this.error} </div>
        <gdm-live-audio-visuals-3d
          .inputNode=${this.inputNode}
          .outputNode=${this.outputNode}
          .visualTone=${this.visualTone}></gdm-live-audio-visuals-3d>
      </div>
    `;
  }
}