import { useEffect, useRef, useState } from 'react'
import { Camera, X } from 'lucide-react'

type ScanQrModalProps = {
  onClose: () => void
  onScan: (value: string) => void
}

export default function ScanQrModal({ onClose, onScan }: ScanQrModalProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [manualValue, setManualValue] = useState('')

  useEffect(() => {
    let stopped = false
    let frame = 0

    const stopCamera = () => {
      if (frame) cancelAnimationFrame(frame)
      streamRef.current?.getTracks().forEach(track => track.stop())
      streamRef.current = null
    }

    const start = async () => {
      try {
        const BarcodeDetectorCtor = (window as any).BarcodeDetector
        if (!BarcodeDetectorCtor) {
          setError('QR scanning is not supported in this browser yet. Paste the Cavo QR link below.')
          return
        }

        const detector = new BarcodeDetectorCtor({ formats: ['qr_code'] })
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' } },
          audio: false,
        })
        streamRef.current = stream
        if (!videoRef.current || stopped) return

        videoRef.current.srcObject = stream
        await videoRef.current.play()

        const scan = async () => {
          if (stopped || !videoRef.current) return
          try {
            const codes = await detector.detect(videoRef.current)
            const value = codes?.[0]?.rawValue
            if (value) {
              stopped = true
              stopCamera()
              onScan(value)
              return
            }
          } catch {
            // Keep scanning while the camera warms up or frames are temporarily unreadable.
          }
          frame = requestAnimationFrame(scan)
        }

        scan()
      } catch (err: any) {
        setError(err?.message || 'Camera permission was denied. Paste the Cavo QR link below.')
      }
    }

    start()
    return () => {
      stopped = true
      stopCamera()
    }
  }, [onScan])

  return (
    <div className="wc-modal scan-qr-modal" onClick={onClose}>
      <div className="card glass wc-card scan-qr-card" onClick={event => event.stopPropagation()}>
        <div className="wc-title scan-qr-title">
          Scan QR Code
          <button className="icon-btn" onClick={onClose} aria-label="Close QR scanner">
            <X size={20} />
          </button>
        </div>
        <p className="wc-sub scan-qr-sub">
          Point your camera at a Cavo payment QR to open the payment screen.
        </p>

        <div className="scan-camera-frame">
          <video ref={videoRef} muted playsInline />
          <div className="scan-corners" />
          <Camera className="scan-camera-icon" size={28} />
        </div>

        {error && <div className="error-text">{error}</div>}

        <div className="form-stack">
          <input
            className="form-input"
            value={manualValue}
            onChange={event => setManualValue(event.target.value)}
            placeholder="Paste Cavo QR link"
          />
          <button className="btn btn-primary btn-full" onClick={() => manualValue && onScan(manualValue)} disabled={!manualValue}>
            Open Payment
          </button>
        </div>
      </div>
    </div>
  )
}
