import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { Palette, Upload, Settings2, BookMarked, Menu } from 'lucide-react';
import { cn } from '@/lib/utils';

const navItems = [
  { href: '/', label: 'Home', icon: Palette },
  { href: '/calibrate', label: 'Calibrate', icon: Settings2 },
  { href: '/batch', label: 'Batch Process', icon: Upload },
  { href: '/presets', label: 'Presets', icon: BookMarked },
];

export function Header() {
  const location = useLocation();
  const [open, setOpen] = useState(false);

  return (
    <header className="sticky top-0 z-50 w-full border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-3 focus:z-[60] focus:rounded-md focus:bg-primary focus:px-3 focus:py-2 focus:text-primary-foreground"
      >
        Skip to content
      </a>

      <div className="container flex h-14 items-center gap-2">
        <Link to="/" className="flex min-w-0 items-center gap-2 mr-2 sm:mr-6">
          <div className="p-1.5 rounded-lg bg-primary shrink-0">
            <Palette className="w-5 h-5 text-primary-foreground" aria-hidden="true" />
          </div>
          <span className="font-semibold text-lg truncate">ColorFix</span>
        </Link>

        {/* Desktop / tablet nav */}
        <nav className="hidden md:flex items-center gap-1 min-w-0" aria-label="Primary">
          {navItems.map(({ href, label, icon: Icon }) => (
            <Button
              key={href}
              variant="ghost"
              size="sm"
              asChild
              className={cn('gap-2', location.pathname === href && 'bg-muted')}
            >
              <Link to={href} aria-current={location.pathname === href ? 'page' : undefined}>
                <Icon className="w-4 h-4" aria-hidden="true" />
                <span>{label}</span>
              </Link>
            </Button>
          ))}
        </nav>

        {/* Compact icon nav for small tablets */}
        <nav className="hidden sm:flex md:hidden items-center gap-0.5 ml-auto" aria-label="Primary">
          {navItems.map(({ href, label, icon: Icon }) => (
            <Button
              key={href}
              variant="ghost"
              size="icon"
              asChild
              className={cn(
                'h-10 w-10',
                location.pathname === href && 'bg-muted'
              )}
            >
              <Link
                to={href}
                aria-label={label}
                aria-current={location.pathname === href ? 'page' : undefined}
              >
                <Icon className="w-4 h-4" aria-hidden="true" />
              </Link>
            </Button>
          ))}
        </nav>

        {/* Mobile hamburger */}
        <div className="ml-auto sm:hidden">
          <Sheet open={open} onOpenChange={setOpen}>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" className="h-10 w-10" aria-label="Open menu">
                <Menu className="w-5 h-5" />
              </Button>
            </SheetTrigger>
            <SheetContent side="right" className="w-[min(20rem,100vw)] p-0">
              <SheetHeader className="border-b px-4 py-4 text-left">
                <SheetTitle className="flex items-center gap-2">
                  <div className="p-1.5 rounded-lg bg-primary">
                    <Palette className="w-4 h-4 text-primary-foreground" aria-hidden="true" />
                  </div>
                  ColorFix
                </SheetTitle>
              </SheetHeader>
              <nav className="flex flex-col gap-1 p-3" aria-label="Mobile">
                {navItems.map(({ href, label, icon: Icon }) => (
                  <Button
                    key={href}
                    variant="ghost"
                    asChild
                    className={cn(
                      'justify-start h-12 gap-3 text-base',
                      location.pathname === href && 'bg-muted'
                    )}
                  >
                    <Link
                      to={href}
                      onClick={() => setOpen(false)}
                      aria-current={location.pathname === href ? 'page' : undefined}
                    >
                      <Icon className="w-5 h-5" aria-hidden="true" />
                      {label}
                    </Link>
                  </Button>
                ))}
              </nav>
            </SheetContent>
          </Sheet>
        </div>
      </div>
    </header>
  );
}
