'use client';

import { useEffect, useRef, useState } from 'react';
import SockJS from 'sockjs-client';
import { Stomp } from '@stomp/stompjs';

export default function VideoRoom() {
  // 주요 상태 및 참조 변수들
  const myKey = useRef(Math.random().toString(36).substring(2, 11)); // 사용자 고유 키
  const pcListMap = useRef(new Map()); // WebRTC 연결을 저장하는 맵
  const otherKeyList = useRef<string[]>([]); // 다른 참가자들의 키 목록
  const localStream = useRef<MediaStream>(); // 로컬 미디어 스트림
  const stompClient = useRef<any>(null); // WebSocket 클라이언트
  const roomId = useRef('2'); // 채팅방 ID

  // 비디오/오디오/화면공유 상태 관리
  const [isVideoEnabled, setIsVideoEnabled] = useState(true);
  const [isAudioEnabled, setIsAudioEnabled] = useState(true);
  const [isScreenSharing, setIsScreenSharing] = useState(false);

  const sendAnswer = (pc: RTCPeerConnection, otherKey: string) => {
    pc.createAnswer().then(answer => {
      pc.setLocalDescription(answer);
      stompClient.current.send(
        `/app/peer/answer/${otherKey}/${roomId.current}`,
        {},
        JSON.stringify({
          key: myKey.current,
          body: answer,
        }),
      );
      console.log('Send answer');
    });
  };

  const onTrack = (event: RTCTrackEvent, otherKey: string) => {
    if (document.getElementById(`video-${otherKey}`) === null) {
      const videoContainer = document.createElement('div');
      videoContainer.className = 'relative aspect-video';

      const video = document.createElement('video');
      video.id = `video-${otherKey}`;
      video.autoplay = true;
      video.playsInline = true;
      video.className = 'w-full h-full object-cover rounded-lg cursor-pointer';
      video.srcObject = event.streams[0];

      video.onloadedmetadata = () => {
        console.log(`Video metadata loaded for ${otherKey}`);
        video.play().catch(e => console.error('Video play failed:', e));
      };

      const label = document.createElement('span');
      label.className =
        'absolute bottom-2 left-2 bg-black/50 text-white px-2 py-1 rounded';
      label.textContent = `참가자 ${otherKeyList.current.indexOf(otherKey) + 1}`;

      videoContainer.appendChild(video);
      videoContainer.appendChild(label);

      const remoteStreamDiv = document.getElementById('remoteStreamDiv');
      if (remoteStreamDiv) {
        remoteStreamDiv.appendChild(videoContainer);
      }

      console.log('Remote video added:', otherKey);
      console.log('Stream tracks:', event.streams[0].getTracks());
    } else {
      const existingVideo = document.getElementById(
        `video-${otherKey}`,
      ) as HTMLVideoElement;
      if (existingVideo && existingVideo.srcObject !== event.streams[0]) {
        existingVideo.srcObject = event.streams[0];
        console.log('Updated existing video stream:', otherKey);

        existingVideo.onloadedmetadata = () => {
          console.log(`Existing video metadata loaded for ${otherKey}`);
          existingVideo
            .play()
            .catch(e => console.error('Existing video play failed:', e));
        };
      }
    }
  };

  const createPeerConnection = (otherKey: string) => {
    // STUN/TURN 서버 설정
    const configuration = {
      iceServers: [
        { urls: process.env.NEXT_PUBLIC_STUN_URL || '' },
        {
          urls: process.env.NEXT_PUBLIC_TURN_URL || '',
          username: process.env.NEXT_PUBLIC_TURN_USERNAME || '',
          credential: process.env.NEXT_PUBLIC_TURN_CREDENTIAL || '',
        },
      ],
    };

    const pc = new RTCPeerConnection(configuration);
    try {
      pc.addEventListener('icecandidate', event => {
        if (event.candidate) {
          console.log('ICE candidate');
          stompClient.current?.send(
            `/app/peer/iceCandidate/${otherKey}/${roomId.current}`,
            {},
            JSON.stringify({
              key: myKey.current,
              body: event.candidate,
            }),
          );
        }
      });

      pc.ontrack = event => {
        console.log('Track event details:', {
          otherKey,
          trackKind: event.track.kind,
          streamId: event.streams[0]?.id,
          trackId: event.track.id,
          existingVideo: document.getElementById(`video-${otherKey}`),
          streamActive: event.streams[0]?.active,
          trackEnabled: event.track.enabled,
          trackMuted: event.track.muted,
        });
        onTrack(event, otherKey);
      };

      if (localStream.current) {
        localStream.current.getTracks().forEach(track => {
          console.log('Adding local track to peer connection:', track.kind);
          pc.addTrack(track, localStream.current!);
        });
      }

      console.log('PeerConnection created for:', otherKey);

      // ICE 연결 상태 모니터링
      pc.addEventListener('iceconnectionstatechange', () => {
        console.log(
          `ICE Connection State (${otherKey}): ${pc.iceConnectionState}`,
        );
        if (pc.iceConnectionState === 'connected') {
          console.log(`Peer connection with ${otherKey} established.`);
        } else if (
          pc.iceConnectionState === 'failed' ||
          pc.iceConnectionState === 'disconnected'
        ) {
          console.warn(
            `Peer connection with ${otherKey} ${pc.iceConnectionState}`,
          );
          // 연결 실패나 끊김 상태일 때 일정 시간 후에도 상태가 변하지 않으면 참가자 제거
          setTimeout(() => {
            if (
              pc.iceConnectionState === 'failed' ||
              pc.iceConnectionState === 'disconnected'
            ) {
              console.log(
                `Removing participant ${otherKey} due to connection ${pc.iceConnectionState}`,
              );
              removeParticipant(otherKey);
            }
          }, 1000); // 1초 후 체크
        }
      });
    } catch (error) {
      console.error('PeerConnection failed: ', error);
    }
    return pc;
  };

  const startCam = async () => {
    // 카메라와 마이크 접근 권한 요청 및 스트림 설정
    if (navigator.mediaDevices) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: true,
          video: true,
        });
        console.log('Stream found');
        localStream.current = stream;
        stream.getAudioTracks()[0].enabled = true;
        const localVideo = document.getElementById(
          'localStream',
        ) as HTMLVideoElement;
        if (localVideo) {
          localVideo.srcObject = stream;
        }
      } catch (error) {
        console.error('미디어 장치 접근 오류:', error);
      }
    }
  };

  const connectSocket = async () => {
    const socketUrl = process.env.NEXT_PUBLIC_SOCKET_URL;

    if (!socketUrl) {
      console.error('Socket URL is not configured');
      return;
    }

    console.log('Connecting to socket URL:', socketUrl);

    stompClient.current = Stomp.over(new SockJS(`${socketUrl}/signaling`));
    stompClient.current.debug = () => {};

    stompClient.current.connect({}, function () {
      console.log('Connected to WebRTC server');

      stompClient.current.subscribe(
        `/topic/peer/iceCandidate/${myKey.current}/${roomId.current}`,
        (candidate: any) => {
          const key = JSON.parse(candidate.body).key;
          const message = JSON.parse(candidate.body).body;
          pcListMap.current.get(key)?.addIceCandidate(
            new RTCIceCandidate({
              candidate: message.candidate,
              sdpMLineIndex: message.sdpMLineIndex,
              sdpMid: message.sdpMid,
            }),
          );
        },
      );

      stompClient.current.subscribe(
        `/topic/peer/offer/${myKey.current}/${roomId.current}`,
        (offer: any) => {
          const key = JSON.parse(offer.body).key;
          const message = JSON.parse(offer.body).body;

          pcListMap.current.set(key, createPeerConnection(key));
          pcListMap.current.get(key)?.setRemoteDescription(
            new RTCSessionDescription({
              type: message.type,
              sdp: message.sdp,
            }),
          );
          sendAnswer(pcListMap.current.get(key)!, key);
        },
      );

      stompClient.current.subscribe(
        `/topic/peer/answer/${myKey.current}/${roomId.current}`,
        async (answer: any) => {
          try {
            const key = JSON.parse(answer.body).key;
            const message = JSON.parse(answer.body).body;
            const pc = pcListMap.current.get(key);

            // 안전 장치 추가
            if (pc && pc.signalingState === 'have-local-offer') {
              await pc.setRemoteDescription(new RTCSessionDescription(message));
            } else {
              console.warn('Unexpected signaling state:', pc?.signalingState);
              // 잘못된 상태일 때는 그냥 무시 (기존 연결 유지)
            }
          } catch (error) {
            console.debug('Error setting remote description:', error);
            // 에러가 발생해도 기존 연결은 유지
          }
        },
      );

      stompClient.current.subscribe(`/topic/call/key`, () => {
        stompClient.current.send(
          `/app/send/key`,
          {},
          JSON.stringify(myKey.current),
        );
      });

      stompClient.current.subscribe(`/topic/send/key`, (message: any) => {
        const key = JSON.parse(message.body);
        if (
          myKey.current !== key &&
          otherKeyList.current.find(mapKey => mapKey === myKey.current) ===
            undefined
        ) {
          otherKeyList.current.push(key);
        }
      });
    });
  };

  const startStreaming = async () => {
    // 스트리밍 시작 및 피어 연결 설정
    try {
      // 먼저 로컬 스트림이 준비되었는지 확인
      if (!localStream.current?.active) {
        console.warn('Local stream not ready');
        await startCam(); // 필요한 경우 다시 시도
      }

      // 서버에 키 전송
      await stompClient.current?.send(`/app/call/key`, {}, {});

      // 피어 연결 설정을 위한 시간 증가 (1초 -> 2초)
      await new Promise(resolve => setTimeout(resolve, 2000));

      // 각 피어에 대해 연결 설정
      for (const key of otherKeyList.current) {
        if (!pcListMap.current.has(key)) {
          try {
            const pc = createPeerConnection(key);
            pcListMap.current.set(key, pc);

            // ICE gathering 상태 모니터링 추가
            pc.onicegatheringstatechange = () => {
              console.log(
                `ICE gathering state for ${key}:`,
                pc.iceGatheringState,
              );
            };

            // offer 생성 및 전송
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);

            stompClient.current?.send(
              `/app/peer/offer/${key}/${roomId.current}`,
              {},
              JSON.stringify({
                key: myKey.current,
                body: offer,
              }),
            );
            console.log('Send offer to:', key);
          } catch (error) {
            console.error(`Error creating connection for peer ${key}:`, error);
            // 실패한 연결 정리
            if (pcListMap.current.has(key)) {
              pcListMap.current.get(key)?.close();
              pcListMap.current.delete(key);
            }
          }
        }
      }
    } catch (error) {
      console.error('스트리밍 시작 오류:', error);
    }
  };

  const removeParticipant = (otherKey: string) => {
    // 참가자 제거 및 관련 리소스 정리
    const videoContainer = document.getElementById(
      `video-${otherKey}`,
    )?.parentElement;
    if (videoContainer) {
      videoContainer.remove();
    }

    otherKeyList.current = otherKeyList.current.filter(key => key !== otherKey);

    const pc = pcListMap.current.get(otherKey);
    if (pc) {
      pc.close();
      pcListMap.current.delete(otherKey);
    }
  };

  // 미디어 제어 함수들
  const toggleVideo = () => {
    // 비디오 ON/OFF 토글
    if (localStream.current) {
      const videoTrack = localStream.current.getVideoTracks()[0];
      if (videoTrack) {
        videoTrack.enabled = !videoTrack.enabled;
        setIsVideoEnabled(videoTrack.enabled);
      }
    }
  };

  const toggleAudio = () => {
    // 오디오 ON/OFF 토글
    if (localStream.current) {
      const audioTrack = localStream.current.getAudioTracks()[0];
      if (audioTrack) {
        audioTrack.enabled = !audioTrack.enabled;
        setIsAudioEnabled(audioTrack.enabled);
      }
    }
  };

  const toggleScreenShare = async () => {
    // 화면 공유 시작/중지
    try {
      if (!isScreenSharing) {
        const screenStream = await navigator.mediaDevices.getDisplayMedia({
          video: true,
        });
        const videoTrack = screenStream.getVideoTracks()[0];

        // 화면 공유 종료 시 자동으로 카메라로 복귀
        videoTrack.onended = () => {
          const cameraTrack = localStream.current?.getVideoTracks()[0];
          if (cameraTrack) {
            pcListMap.current.forEach(pc => {
              const sender = pc
                .getSenders()
                .find((s: RTCRtpSender) => s.track?.kind === 'video');
              if (sender) sender.replaceTrack(cameraTrack);
            });
          }
          setIsScreenSharing(false);
        };

        // 모든 피어 연결에 화면 공유 트랙으로 교체
        pcListMap.current.forEach(pc => {
          const sender = pc
            .getSenders()
            .find((s: RTCRtpSender) => s.track?.kind === 'video');
          if (sender) sender.replaceTrack(videoTrack);
        });

        setIsScreenSharing(true);
      } else {
        // 화면 하단의 화면 공유 중지 버튼 클릭시 카메라로 복귀
        const videoTrack = localStream.current?.getVideoTracks()[0];
        if (videoTrack) {
          pcListMap.current.forEach(pc => {
            const sender = pc
              .getSenders()
              .find((s: RTCRtpSender) => s.track?.kind === 'video');
            if (sender) sender.replaceTrack(videoTrack);
          });
        }
        setIsScreenSharing(false);
      }
    } catch (error) {
      console.error('Error sharing screen:', error);
      setIsScreenSharing(false);
    }
  };

  useEffect(() => {
    // 컴포넌트 마운트 시 초기화 및 정리
    const init = async () => {
      await startCam();
      await connectSocket();
    };
    init();

    // 컴포넌트 언마운트 시 정리 작업
    return () => {
      // 모든 미디어 트랙 중지
      localStream.current?.getTracks().forEach(track => track.stop());
      // 모든 피어 연결 종료
      pcListMap.current.forEach((pc, key) => {
        pc.close();
        removeParticipant(key);
      });
      pcListMap.current.clear();

      if (stompClient.current?.connected) {
        stompClient.current.disconnect();
      }

      otherKeyList.current = [];
    };
  }, []);

  // UI 렌더링
  return (
    <div className="p-4">
      <div className="flex justify-between items-center mb-4 max-w-7xl mx-auto">
        <button
          type="button"
          id="startStreamBtn"
          onClick={startStreaming}
          className="px-4 py-2 bg-green-500 text-white rounded hover:bg-green-600 transition-colors"
          style={{ display: 'none' }}
        >
          스터디룸 입장
        </button>
      </div>

      <div className="max-w-7xl mx-auto">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {/* 로컬 비디오 */}
          <div className="relative aspect-video rounded-lg overflow-hidden">
            <video
              id="localStream"
              autoPlay
              playsInline
              controls
              muted
              style={{ display: 'none' }}
              className="absolute inset-0 w-full h-full object-cover"
            />
            <span className="absolute bottom-2 left-2 bg-black/50 text-white px-2 py-1 rounded text-sm">
              나
            </span>
          </div>

          {/* 원격 비디오 */}
          <div id="remoteStreamDiv" className="contents">
            {/* 동적으로 추가되는 비디오들 */}
          </div>
        </div>
      </div>

      <div className="fixed bottom-4 left-1/2 transform -translate-x-1/2 flex flex-wrap justify-center gap-2 bg-black/50 p-2 rounded-lg backdrop-blur-sm z-50">
        <button
          onClick={toggleAudio}
          className={`px-4 py-2 rounded transition-colors ${
            isAudioEnabled
              ? 'bg-blue-500 hover:bg-blue-600 text-white'
              : 'bg-red-500 hover:bg-red-600 text-white'
          }`}
        >
          {isAudioEnabled ? '마이크 끄기' : '마이크 켜기'}
        </button>
        <button
          onClick={toggleVideo}
          className={`px-4 py-2 rounded transition-colors ${
            isVideoEnabled
              ? 'bg-blue-500 hover:bg-blue-600 text-white'
              : 'bg-red-500 hover:bg-red-600 text-white'
          }`}
        >
          {isVideoEnabled ? '카메라 끄기' : '카메라 켜기'}
        </button>
        <button
          onClick={toggleScreenShare}
          className={`px-4 py-2 rounded transition-colors ${
            isScreenSharing
              ? 'bg-red-500 hover:bg-red-600 text-white'
              : 'bg-blue-500 hover:bg-blue-600 text-white'
          }`}
        >
          {isScreenSharing ? '화면 공유 중지' : '화면 공유'}
        </button>
      </div>
    </div>
  );
}
