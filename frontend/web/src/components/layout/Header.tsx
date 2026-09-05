import ShinyText from '@/components/reactbits/ShinyText'

export default function Header() {
  return (
    <header className="text-center pt-8 pb-2">
      <h1 className="text-4xl md:text-5xl font-bold mb-2">
        <ShinyText
          text="🤖 Agentes de Análise de Conteúdo"
          speed={3}
          shineColor="#c084fc"
          color="#e2e8f0"
        />
      </h1>
      <p className="text-slate-400 text-sm max-w-xl mx-auto">
        Faça upload de conteúdo ou cole um link do YouTube para criar aulas com diagramas e questões de múltipla escolha.
      </p>
    </header>
  )
}
