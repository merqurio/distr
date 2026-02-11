import {AsyncPipe, DatePipe} from '@angular/common';
import {Component, DestroyRef, inject} from '@angular/core';
import {takeUntilDestroyed} from '@angular/core/rxjs-interop';
import {FormControl, ReactiveFormsModule} from '@angular/forms';
import {ActivatedRoute, Params, Router} from '@angular/router';
import {FaIconComponent} from '@fortawesome/angular-fontawesome';
import {faDownload} from '@fortawesome/free-solid-svg-icons';
import {combineLatest, debounceTime, first, map, of, scan, shareReplay, startWith, Subject, switchMap, tap} from 'rxjs';
import {ArtifactPullFilters, ArtifactPullsService} from '../../services/artifact-pulls.service';
import {ToastService} from '../../services/toast.service';
import {ArtifactPullFilterOption} from '../../types/artifact-version-pull';

interface FilterDef {
  queryParam: string;
  control: FormControl<string | null>;
}

@Component({
  templateUrl: './artifact-pulls.component.html',
  imports: [AsyncPipe, DatePipe, ReactiveFormsModule, FaIconComponent],
})
export class ArtifactPullsComponent {
  private readonly pullsService = inject(ArtifactPullsService);
  private readonly toast = inject(ToastService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly faDownload = faDownload;
  protected hasMore = true;
  protected isExporting = false;
  private currentOldestPull?: Date;
  private readonly fetchCount = 50;
  private readonly showMore$ = new Subject<void>();
  private initializing = true;

  protected readonly customerOrgFilter = new FormControl('');
  protected readonly userAccountFilter = new FormControl('');
  protected readonly remoteAddressFilter = new FormControl('');
  protected readonly artifactFilter = new FormControl('');
  protected readonly artifactVersionFilter = new FormControl('');
  protected readonly dateFromFilter = new FormControl('');
  protected readonly dateToFilter = new FormControl('');

  private readonly filterDefs: FilterDef[] = [
    {queryParam: 'customerOrganizationId', control: this.customerOrgFilter},
    {queryParam: 'userAccountId', control: this.userAccountFilter},
    {queryParam: 'remoteAddress', control: this.remoteAddressFilter},
    {queryParam: 'artifactId', control: this.artifactFilter},
    {queryParam: 'artifactVersionId', control: this.artifactVersionFilter},
    {queryParam: 'from', control: this.dateFromFilter},
    {queryParam: 'to', control: this.dateToFilter},
  ];

  protected readonly filterOptions$ = this.pullsService.getFilterOptions().pipe(shareReplay(1));

  protected readonly versionOptions$ = this.artifactFilter.valueChanges.pipe(
    startWith(this.artifactFilter.value),
    switchMap((artifactId) => {
      if (!this.initializing) {
        this.artifactVersionFilter.setValue('', {emitEvent: false});
      }
      if (artifactId) {
        return this.pullsService.getVersionOptions(artifactId);
      }
      return of([] as ArtifactPullFilterOption[]);
    }),
    shareReplay(1)
  );

  private readonly allFilterValues$ = combineLatest(
    this.filterDefs.map((f) => f.control.valueChanges.pipe(startWith(f.control.value)))
  );

  private readonly filters$ = this.filterOptions$.pipe(
    switchMap(() => this.allFilterValues$),
    debounceTime(300),
    tap(() => (this.initializing = false)),
    tap((values) => this.syncQueryParams(values)),
    map((values) => this.buildFilters(values)),
    shareReplay(1)
  );

  protected readonly pulls$ = this.filters$.pipe(
    switchMap((filters) => {
      this.currentOldestPull = undefined;
      this.hasMore = true;
      return this.showMore$.pipe(
        startWith(undefined),
        switchMap(() =>
          this.pullsService.get({
            ...filters,
            before: this.currentOldestPull,
            count: this.fetchCount,
          })
        ),
        tap((it) => {
          if (it.length > 0) {
            this.currentOldestPull = new Date(it[it.length - 1].createdAt);
          }
          if (it.length < this.fetchCount) {
            this.hasMore = false;
          }
        }),
        scan((all, next) => [...all, ...next])
      );
    }),
    shareReplay(1)
  );

  constructor() {
    this.initFromQueryParams();
  }

  protected showMore() {
    this.showMore$.next();
  }

  protected exportCsv() {
    this.isExporting = true;
    const toastRef = this.toast.info('Download started...');
    const filters = this.buildFilters(this.filterDefs.map((f) => f.control.value));
    this.pullsService.export(filters).subscribe({
      next: (blob) => {
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${new Date().toISOString().split('T')[0]}_artifact_pulls.csv`;
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
        document.body.removeChild(a);
        this.isExporting = false;
        toastRef.toastRef.close();
        this.toast.success('Download completed successfully');
      },
      error: () => {
        this.isExporting = false;
        toastRef.toastRef.close();
        this.toast.error('Export failed');
      },
    });
  }

  protected formatVersionName(name: string): string {
    const shaPrefix = 'sha256:';
    if (name.startsWith(shaPrefix)) {
      return shaPrefix + name.substring(shaPrefix.length, shaPrefix.length + 8);
    }
    return name;
  }

  protected formatRemoteAddress(addr: string): string {
    if (addr.includes(']')) {
      return addr.substring(0, addr.lastIndexOf(']') + 1);
    } else if (addr.includes(':')) {
      return addr.substring(0, addr.lastIndexOf(':'));
    } else {
      return addr;
    }
  }

  private initFromQueryParams() {
    const params = this.route.snapshot.queryParams;
    const hasParams = this.filterDefs.some((f) => params[f.queryParam]);
    if (!hasParams) {
      return;
    }

    // Wait for filter options to load, then apply query params.
    // This ensures <select> elements have their <option> children
    // before we set a value, preventing Angular from resetting them.
    this.filterOptions$.pipe(first(), takeUntilDestroyed(this.destroyRef)).subscribe(() => {
      // Use setTimeout to let Angular complete the render cycle
      // so that <option> elements from @for are in the DOM
      setTimeout(() => {
        for (const def of this.filterDefs) {
          const value = params[def.queryParam];
          if (value) {
            def.control.setValue(value);
          }
        }
      });
    });
  }

  private syncQueryParams(values: (string | null)[]) {
    const queryParams: Params = {};
    for (let i = 0; i < this.filterDefs.length; i++) {
      queryParams[this.filterDefs[i].queryParam] = values[i] || null;
    }
    this.router.navigate([], {queryParams, replaceUrl: true});
  }

  private buildFilters(values: (string | null)[]): ArtifactPullFilters {
    const filters: ArtifactPullFilters = {};
    const [custOrg, user, addr, artifact, version, from, to] = values;
    if (custOrg) {
      filters.customerOrganizationId = custOrg;
    }
    if (user) {
      filters.userAccountId = user;
    }
    if (addr) {
      filters.remoteAddress = addr;
    }
    if (artifact) {
      filters.artifactId = artifact;
    }
    if (version) {
      filters.artifactVersionId = version;
    }
    if (from) {
      filters.after = new Date(from);
    }
    if (to) {
      const toDate = new Date(to);
      toDate.setHours(23, 59, 59, 999);
      filters.before = toDate;
    }
    return filters;
  }
}
