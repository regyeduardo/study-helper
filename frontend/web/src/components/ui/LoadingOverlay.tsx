export default function LoadingOverlay({
  isLoading,
  message,
  subMessage,
}: {
  isLoading: boolean
  message?: string
  subMessage?: string
}) {
  if (!isLoading) return null

  return (
    <div className="fixed inset-0 z-9999 flex items-center justify-center bg-black/70 backdrop-blur-md">
      <div className="text-center p-8">
        <div className="relative w-16 h-16 mx-auto mb-4">
          <div className="absolute inset-0 rounded-full border-4 border-violet-500/30 border-t-violet-400 animate-spin" />
          <div className="absolute inset-2 rounded-full border-4 border-cyan-400/30 border-b-cyan-400 animate-spin animation-delay-150" />
        </div>
        <p className="text-lg font-medium text-white">{message || 'Processando...'}</p>
        <p className="text-sm text-white/60 mt-1">{subMessage || 'Aguarde, pode levar vários minutos.'}</p>
      </div>
    </div>
  )
}
