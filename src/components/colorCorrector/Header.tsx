import { Link, useLocation } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Palette, Upload, Settings2, BookMarked } from 'lucide-react';
import { cn } from '@/lib/utils';

const navItems = [
  { href: '/', label: 'Home', icon: Palette },
  { href: '/calibrate', label: 'Calibrate', icon: Settings2 },
  { href: '/batch', label: 'Batch Process', icon: Upload },
  { href: '/presets', label: 'Presets', icon: BookMarked },
];

export function Header() {
  const location = useLocation();

  return (
    <header className="sticky top-0 z-50 w-full border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="container flex h-14 items-center">
        <Link to="/" className="flex items-center gap-2 mr-8">
          <div className="p-1.5 rounded-lg bg-primary">
            <Palette className="w-5 h-5 text-primary-foreground" />
          </div>
          <span className="font-semibold text-lg">ColorFix</span>
        </Link>

        <nav className="flex items-center gap-1">
          {navItems.map(({ href, label, icon: Icon }) => (
            <Button
              key={href}
              variant="ghost"
              size="sm"
              asChild
              className={cn(
                'gap-2',
                location.pathname === href && 'bg-muted'
              )}
            >
              <Link to={href}>
                <Icon className="w-4 h-4" />
                <span className="hidden sm:inline">{label}</span>
              </Link>
            </Button>
          ))}
        </nav>
      </div>
    </header>
  );
}
