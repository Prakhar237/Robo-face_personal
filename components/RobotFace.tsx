import React, { useRef, useEffect, useState } from 'react';
import { AppState, Emotion } from '../types';

interface RobotFaceProps {
  state: AppState;
  emotion: Emotion;
  width?: number | string;
  height?: number | string;
  onVideoEnded?: () => void;
}

const RobotFace: React.FC<RobotFaceProps> = ({ state, width = '100%', height = '100%', onVideoEnded }) => {
  const video1Ref = useRef<HTMLVideoElement>(null);
  const video2Ref = useRef<HTMLVideoElement>(null);

  // Manage which video element is currently the "active" visible one.
  const [activeVideoIndex, setActiveVideoIndex] = useState<1 | 2>(1);
  const [currentSrc, setCurrentSrc] = useState<string>('');

  const getVideoProps = (currentState: AppState) => {
    switch (currentState) {
      case AppState.IMAGE_GEN_COUNTDOWN:
        return { src: '/RoboThinkingStart.mp4', loop: false };
      case AppState.IMAGE_GEN_RECORDING:
      case AppState.IMAGE_GEN_GENERATING:
      case AppState.IMAGE_GEN_RESULT:
        return { src: '/RoboThinkingLoop2.mp4', loop: true };
      case AppState.IMAGE_GEN_TRANSITION_BACK:
        return { src: '/robob2s.mp4', loop: false };
      case AppState.SPEAKING:
        return { src: '/Robospeak2.mp4', loop: true };
      case AppState.IDLE:
      case AppState.LISTENING:
      case AppState.ERROR:
      case AppState.THINKING:
      default:
        return { src: '/videopro.mp4', loop: true };
    }
  };

  const { src, loop } = getVideoProps(state);

  // Decide sizing behavior: If we are in split screen (Image Gen Phase B), use contain so we don't crop the face
  const isSplitScreen = [
    AppState.IMAGE_GEN_RECORDING,
    AppState.IMAGE_GEN_GENERATING,
    AppState.IMAGE_GEN_RESULT
  ].includes(state);
  const objectFitClass = isSplitScreen ? 'object-contain' : 'object-cover';

  useEffect(() => {
    if (src === currentSrc) return; // Prevent re-triggering for same video

    const activeRef = activeVideoIndex === 1 ? video1Ref : video2Ref;
    const nextRef = activeVideoIndex === 1 ? video2Ref : video1Ref;
    const nextIndex = activeVideoIndex === 1 ? 2 : 1;

    if (nextRef.current) {
      // Setup the hidden video with the new source
      nextRef.current.src = src;
      nextRef.current.loop = loop;
      nextRef.current.muted = true;
      // When it has enough data to play, play it and swap opacities
      nextRef.current.oncanplay = () => {
        nextRef.current?.play().then(() => {
          setActiveVideoIndex(nextIndex);
          setCurrentSrc(src);

          setTimeout(() => {
            if (activeRef.current) activeRef.current.pause();
          }, 600);
        }).catch(e => {
          if (e.name !== 'AbortError') console.error("Seamless playback failed", e);
        });
      };
      nextRef.current.load();
    }

    // Initial mount condition (when currentSrc is empty)
    if (!currentSrc && activeRef.current) {
      activeRef.current.src = src;
      activeRef.current.loop = loop;
      activeRef.current.load();
      activeRef.current.play().catch(e => {
        if (e.name !== 'AbortError') console.error("Initial playback failed", e);
      });
      setCurrentSrc(src);
    }

  }, [src, loop, activeVideoIndex, currentSrc]);

  return (
    <div className="relative flex items-center justify-center bg-black overflow-hidden" style={{ width, height }}>
      <video
        ref={video1Ref}
        muted
        playsInline
        className={`absolute inset-0 w-full h-full transition-opacity duration-500 ease-in-out ${activeVideoIndex === 1 ? 'opacity-100 z-10' : 'opacity-0 z-0'} ${objectFitClass}`}
        onEnded={() => {
          if (!video1Ref.current?.loop && activeVideoIndex === 1 && onVideoEnded) {
            onVideoEnded();
          }
        }}
      />
      <video
        ref={video2Ref}
        muted
        playsInline
        className={`absolute inset-0 w-full h-full transition-opacity duration-500 ease-in-out ${activeVideoIndex === 2 ? 'opacity-100 z-10' : 'opacity-0 z-0'} ${objectFitClass}`}
        onEnded={() => {
          if (!video2Ref.current?.loop && activeVideoIndex === 2 && onVideoEnded) {
            onVideoEnded();
          }
        }}
      />
    </div>
  );
};

export default RobotFace;