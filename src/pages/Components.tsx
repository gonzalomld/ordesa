import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  AlertCircle, ArrowRight, Bell, Check, ChevronRight, Home,
  Loader2, Mail, Plus, Settings, Star, Terminal, User,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

/* ─────────────────────────── Section wrapper ─────────────────────────── */
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-4">
      <h2 className="text-2xl font-semibold tracking-tight text-foreground border-b border-border pb-2">
        {title}
      </h2>
      <div className="space-y-4">{children}</div>
    </section>
  );
}

/* ═══════════════════════════════════════════════════════════════════════ */
export default function Components() {
  const [sliderValue, setSliderValue] = useState([50]);
  const [switchOn, setSwitchOn] = useState(false);

  return (
    <TooltipProvider>
      <div className="min-h-screen bg-background">
        {/* ── Header ── */}
        <header className="sticky top-0 z-50 border-b border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
          <div className="container mx-auto flex h-14 items-center justify-between px-6">
            <div className="flex items-center gap-3">
              <Link to="/" className="flex items-center gap-2 text-foreground hover:text-primary transition-colors">
                <Home size={18} />
                <span className="font-semibold">Inicio</span>
              </Link>
              <ChevronRight size={14} className="text-muted-foreground" />
              <span className="text-muted-foreground">Componentes</span>
            </div>
            <Badge variant="secondary">Scaffold Beta — TW4</Badge>
          </div>
        </header>

        {/* ── Content ── */}
        <main className="container mx-auto px-6 py-10 space-y-12 max-w-4xl">
          <div className="space-y-2">
            <h1 className="text-4xl font-bold tracking-tight text-foreground">
              Catálogo de Componentes
            </h1>
            <p className="text-lg text-muted-foreground">
              Todos los componentes Shadcn/ui renderizados con Tailwind CSS 4.
            </p>
          </div>

          {/* ─── Buttons ─── */}
          <Section title="Buttons">
            <div className="flex flex-wrap gap-3">
              <Button>Default</Button>
              <Button variant="secondary">Secondary</Button>
              <Button variant="destructive">Destructive</Button>
              <Button variant="outline">Outline</Button>
              <Button variant="ghost">Ghost</Button>
              <Button variant="link">Link</Button>
              <Button disabled>Disabled</Button>
              <Button size="sm">Small</Button>
              <Button size="lg">Large</Button>
              <Button size="icon"><Plus size={16} /></Button>
              <Button onClick={() => toast.success("¡Toast funciona!")}>
                <Bell size={16} className="mr-2" /> Toast
              </Button>
            </div>
          </Section>

          {/* ─── Badges ─── */}
          <Section title="Badges">
            <div className="flex flex-wrap gap-3">
              <Badge>Default</Badge>
              <Badge variant="secondary">Secondary</Badge>
              <Badge variant="destructive">Destructive</Badge>
              <Badge variant="outline">Outline</Badge>
            </div>
          </Section>

          {/* ─── Cards ─── */}
          <Section title="Cards">
            <div className="grid gap-4 md:grid-cols-2">
              <Card>
                <CardHeader>
                  <CardTitle>Tarjeta básica</CardTitle>
                  <CardDescription>Descripción de la tarjeta con texto secundario.</CardDescription>
                </CardHeader>
                <CardContent>
                  <p className="text-sm text-muted-foreground">Contenido de la tarjeta.</p>
                </CardContent>
                <CardFooter className="flex justify-between">
                  <Button variant="outline">Cancelar</Button>
                  <Button>Aceptar</Button>
                </CardFooter>
              </Card>
              <Card className="border-primary/20 bg-primary/5">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Star size={18} className="text-primary" />
                    Tarjeta destacada
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-sm">Con estilos personalizados usando variables CSS de TW4.</p>
                </CardContent>
              </Card>
            </div>
          </Section>

          {/* ─── Forms ─── */}
          <Section title="Formularios">
            <Card>
              <CardContent className="pt-6 space-y-6">
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="name">Nombre</Label>
                    <Input id="name" placeholder="Tu nombre" />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="email">Email</Label>
                    <Input id="email" type="email" placeholder="tu@email.com" />
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="message">Mensaje</Label>
                  <Textarea id="message" placeholder="Escribe algo..." rows={3} />
                </div>
                <div className="flex items-center gap-6">
                  <div className="flex items-center space-x-2">
                    <Switch id="dark" checked={switchOn} onCheckedChange={setSwitchOn} />
                    <Label htmlFor="dark">Modo oscuro</Label>
                  </div>
                  <div className="flex items-center space-x-2">
                    <Checkbox id="terms" />
                    <Label htmlFor="terms">Acepto los términos</Label>
                  </div>
                </div>
                <div className="space-y-2">
                  <Label>Selecciona un plan</Label>
                  <RadioGroup defaultValue="pro" className="flex gap-4">
                    <div className="flex items-center space-x-2">
                      <RadioGroupItem value="free" id="free" />
                      <Label htmlFor="free">Free</Label>
                    </div>
                    <div className="flex items-center space-x-2">
                      <RadioGroupItem value="pro" id="pro" />
                      <Label htmlFor="pro">Pro</Label>
                    </div>
                  </RadioGroup>
                </div>
                <div className="space-y-2">
                  <Label>Framework</Label>
                  <Select>
                    <SelectTrigger className="w-[200px]">
                      <SelectValue placeholder="Selecciona..." />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="react">React</SelectItem>
                      <SelectItem value="vue">Vue</SelectItem>
                      <SelectItem value="svelte">Svelte</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Volumen: {sliderValue[0]}%</Label>
                  <Slider value={sliderValue} onValueChange={setSliderValue} max={100} step={1} />
                </div>
              </CardContent>
            </Card>
          </Section>

          {/* ─── Progress ─── */}
          <Section title="Progreso y estados">
            <div className="space-y-4">
              <Progress value={66} />
              <div className="flex items-center gap-4">
                <Skeleton className="h-12 w-12 rounded-full" />
                <div className="space-y-2">
                  <Skeleton className="h-4 w-[250px]" />
                  <Skeleton className="h-4 w-[200px]" />
                </div>
              </div>
              <div className="flex gap-3">
                <Button disabled><Loader2 className="mr-2 h-4 w-4 animate-spin" />Cargando</Button>
              </div>
            </div>
          </Section>

          {/* ─── Alerts ─── */}
          <Section title="Alertas">
            <Alert>
              <Terminal className="h-4 w-4" />
              <AlertTitle>Info</AlertTitle>
              <AlertDescription>Alerta informativa estándar.</AlertDescription>
            </Alert>
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertTitle>Error</AlertTitle>
              <AlertDescription>Algo salió mal. Inténtalo de nuevo.</AlertDescription>
            </Alert>
          </Section>

          {/* ─── Avatars ─── */}
          <Section title="Avatares">
            <div className="flex items-center gap-4">
              <Avatar>
                <AvatarImage src="https://github.com/shadcn.png" alt="@shadcn" />
                <AvatarFallback>SC</AvatarFallback>
              </Avatar>
              <Avatar>
                <AvatarFallback><User size={18} /></AvatarFallback>
              </Avatar>
              <Avatar>
                <AvatarFallback className="bg-primary text-primary-foreground">JP</AvatarFallback>
              </Avatar>
            </div>
          </Section>

          {/* ─── Tabs ─── */}
          <Section title="Tabs">
            <Tabs defaultValue="overview" className="w-full">
              <TabsList>
                <TabsTrigger value="overview">General</TabsTrigger>
                <TabsTrigger value="analytics">Analíticas</TabsTrigger>
                <TabsTrigger value="settings">Ajustes</TabsTrigger>
              </TabsList>
              <TabsContent value="overview" className="p-4">
                <p className="text-sm text-muted-foreground">Contenido de la pestaña general.</p>
              </TabsContent>
              <TabsContent value="analytics" className="p-4">
                <p className="text-sm text-muted-foreground">Contenido de analíticas.</p>
              </TabsContent>
              <TabsContent value="settings" className="p-4">
                <p className="text-sm text-muted-foreground">Contenido de ajustes.</p>
              </TabsContent>
            </Tabs>
          </Section>

          {/* ─── Accordion ─── */}
          <Section title="Accordion">
            <Accordion type="single" collapsible className="w-full">
              <AccordionItem value="item-1">
                <AccordionTrigger>¿Qué es Tailwind CSS 4?</AccordionTrigger>
                <AccordionContent>
                  Tailwind CSS v4 usa un motor nuevo basado en Rust, con configuración vía CSS nativo en lugar de archivos JS/TS.
                </AccordionContent>
              </AccordionItem>
              <AccordionItem value="item-2">
                <AccordionTrigger>¿Es compatible con Shadcn/ui?</AccordionTrigger>
                <AccordionContent>
                  Sí. Los componentes Shadcn/ui son compatibles con TW4 usando las nuevas variables CSS --color-*.
                </AccordionContent>
              </AccordionItem>
              <AccordionItem value="item-3">
                <AccordionTrigger>¿Necesito postcss.config?</AccordionTrigger>
                <AccordionContent>
                  No. TW4 usa el plugin de Vite (@tailwindcss/vite) en lugar de PostCSS.
                </AccordionContent>
              </AccordionItem>
            </Accordion>
          </Section>

          {/* ─── Table ─── */}
          <Section title="Tabla">
            <Card>
              <ScrollArea className="w-full">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Componente</TableHead>
                      <TableHead>Estado</TableHead>
                      <TableHead className="text-right">Versión</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {[
                      { name: "Button", status: "Estable", version: "1.0" },
                      { name: "Dialog", status: "Estable", version: "1.0" },
                      { name: "Carousel", status: "Beta", version: "0.9" },
                      { name: "Chart", status: "Beta", version: "0.8" },
                    ].map((row) => (
                      <TableRow key={row.name}>
                        <TableCell className="font-medium">{row.name}</TableCell>
                        <TableCell>
                          <Badge variant={row.status === "Estable" ? "default" : "secondary"}>
                            {row.status}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right">{row.version}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </ScrollArea>
            </Card>
          </Section>

          {/* ─── Dialog ─── */}
          <Section title="Dialog">
            <Dialog>
              <DialogTrigger asChild>
                <Button variant="outline">Abrir diálogo</Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>¿Estás seguro?</DialogTitle>
                  <DialogDescription>
                    Esta acción no se puede deshacer. Se eliminará permanentemente.
                  </DialogDescription>
                </DialogHeader>
                <DialogFooter>
                  <Button variant="outline">Cancelar</Button>
                  <Button variant="destructive">Eliminar</Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </Section>

          {/* ─── Tooltips ─── */}
          <Section title="Tooltips">
            <div className="flex gap-4">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="outline" size="icon"><Settings size={16} /></Button>
                </TooltipTrigger>
                <TooltipContent><p>Configuración</p></TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="outline" size="icon"><Mail size={16} /></Button>
                </TooltipTrigger>
                <TooltipContent><p>Correo electrónico</p></TooltipContent>
              </Tooltip>
            </div>
          </Section>

          {/* ─── Separator ─── */}
          <Separator />

          {/* ─── CSS Variables test ─── */}
          <Section title="Variables CSS (TW4)">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {[
                { name: "background", className: "bg-background border" },
                { name: "foreground", className: "bg-foreground" },
                { name: "primary", className: "bg-primary" },
                { name: "secondary", className: "bg-secondary border" },
                { name: "muted", className: "bg-muted border" },
                { name: "accent", className: "bg-accent border" },
                { name: "destructive", className: "bg-destructive" },
                { name: "card", className: "bg-card border" },
              ].map(({ name, className }) => (
                <div key={name} className="flex flex-col items-center gap-1">
                  <div className={`w-full h-12 rounded-lg ${className}`} />
                  <span className="text-xs text-muted-foreground">{name}</span>
                </div>
              ))}
            </div>
            <div className="grid grid-cols-5 gap-3 mt-4">
              {["chart-1", "chart-2", "chart-3", "chart-4", "chart-5"].map((name) => (
                <div key={name} className="flex flex-col items-center gap-1">
                  <div className={`w-full h-8 rounded-md bg-${name}`} />
                  <span className="text-xs text-muted-foreground">{name}</span>
                </div>
              ))}
            </div>
          </Section>

          {/* ─── Typography ─── */}
          <Section title="Tipografía">
            <div className="space-y-3">
              <h1 className="scroll-m-20 text-4xl font-extrabold tracking-tight lg:text-5xl">
                Heading 1
              </h1>
              <h2 className="scroll-m-20 text-3xl font-semibold tracking-tight">
                Heading 2
              </h2>
              <h3 className="scroll-m-20 text-2xl font-semibold tracking-tight">
                Heading 3
              </h3>
              <h4 className="scroll-m-20 text-xl font-semibold tracking-tight">
                Heading 4
              </h4>
              <p className="leading-7">
                Párrafo estándar con <code className="relative rounded bg-muted px-[0.3rem] py-[0.2rem] font-mono text-sm">código inline</code> y texto normal.
              </p>
              <p className="text-sm text-muted-foreground">
                Texto secundario con color muted-foreground.
              </p>
              <blockquote className="border-l-2 border-primary pl-6 italic text-muted-foreground">
                "El diseño no es cómo se ve, es cómo funciona." — Steve Jobs
              </blockquote>
            </div>
          </Section>

          {/* ── Footer ── */}
          <footer className="border-t border-border pt-8 pb-12 text-center text-sm text-muted-foreground">
            <p>Scaffold React Beta — Tailwind CSS 4 + Shadcn/ui + Vite 6</p>
            <div className="flex items-center justify-center gap-2 mt-2">
              <Link to="/" className="text-primary hover:underline flex items-center gap-1">
                <ArrowRight size={14} className="rotate-180" /> Volver al inicio
              </Link>
            </div>
          </footer>
        </main>
      </div>
    </TooltipProvider>
  );
}
