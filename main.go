// Command flightguide serves a JSON API over discs.db and a frontend that
// charts the discs by speed and stability.
//
// Usage: flightguide [-db discs.db] [-addr localhost:8417]
package main

import (
	"database/sql"
	"embed"
	"encoding/json"
	"errors"
	"flag"
	"io/fs"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"

	_ "modernc.org/sqlite"
)

//go:embed static
var static embed.FS

type Disc struct {
	ID              int      `json:"id"`
	Brand           string   `json:"brand"`
	Model           string   `json:"model"`
	PDGAModel       *string  `json:"pdga_model"`
	Category        *string  `json:"category"`
	Speed           float64  `json:"speed"`
	Glide           float64  `json:"glide"`
	Turn            float64  `json:"turn"`
	Fade            float64  `json:"fade"`
	Stability       *string  `json:"stability"`
	StabilityGroup  *string  `json:"stability_group"`
	OutOfProduction bool     `json:"out_of_production"`
	InStockProducts *int     `json:"in_stock_products"`
	OnSale          *bool    `json:"on_sale"`
	BgColor         *string  `json:"bg_color"`
	TextColor       *string  `json:"text_color"`
	Link            *string  `json:"link"`
	Image           *string  `json:"image"`
	DiameterCM      *float64 `json:"diameter_cm,omitempty"`
	HeightCM        *float64 `json:"height_cm,omitempty"`
	RimDepthCM      *float64 `json:"rim_depth_cm,omitempty"`
	RimThicknessCM  *float64 `json:"rim_thickness_cm,omitempty"`
	MaxWeightG      *float64 `json:"max_weight_g,omitempty"`
	PDGAApproved    *string  `json:"pdga_approved_date,omitempty"`
	Description     *string  `json:"description,omitempty"`
}

const listColumns = `id, brand, model, pdga_model, category, speed, glide, turn, fade,
	stability, stability_group, out_of_production, in_stock_products, on_sale,
	bg_color, text_color, link, image`

func (d *Disc) listFields() []any {
	return []any{&d.ID, &d.Brand, &d.Model, &d.PDGAModel, &d.Category,
		&d.Speed, &d.Glide, &d.Turn, &d.Fade, &d.Stability, &d.StabilityGroup,
		&d.OutOfProduction, &d.InStockProducts, &d.OnSale, &d.BgColor,
		&d.TextColor, &d.Link, &d.Image}
}

type server struct {
	db *sql.DB
}

// rangeFilters maps query parameter prefixes to SQL expressions; each accepts
// <prefix>_min and <prefix>_max.
var rangeFilters = []struct{ param, expr string }{
	{"speed", "speed"},
	{"glide", "glide"},
	{"turn", "turn"},
	{"fade", "fade"},
	{"stability", "(turn + fade)"},
}

// listDiscs handles GET /api/discs. Supported query parameters:
//
//	brand, category    repeatable; match any
//	q                  substring of model or pdga_model
//	<x>_min, <x>_max   for speed, glide, turn, fade, stability (turn+fade)
//	oop=0              exclude out of production discs
//	in_stock=1         only discs with stock in flightguide.json
func (s *server) listDiscs(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	var where []string
	var args []any

	for _, col := range []string{"brand", "category"} {
		if vals := q[col]; len(vals) > 0 {
			where = append(where, col+" IN ("+strings.TrimSuffix(strings.Repeat("?,", len(vals)), ",")+")")
			for _, v := range vals {
				args = append(args, v)
			}
		}
	}
	for _, f := range rangeFilters {
		for suffix, op := range map[string]string{"_min": ">=", "_max": "<="} {
			v := q.Get(f.param + suffix)
			if v == "" {
				continue
			}
			n, err := strconv.ParseFloat(v, 64)
			if err != nil {
				httpError(w, http.StatusBadRequest, "invalid "+f.param+suffix)
				return
			}
			where = append(where, f.expr+" "+op+" ?")
			args = append(args, n)
		}
	}
	if v := strings.TrimSpace(q.Get("q")); v != "" {
		where = append(where, "(model LIKE ? OR pdga_model LIKE ?)")
		args = append(args, "%"+v+"%", "%"+v+"%")
	}
	if q.Get("oop") == "0" {
		where = append(where, "NOT out_of_production")
	}
	if q.Get("in_stock") == "1" {
		where = append(where, "in_stock_products > 0")
	}

	query := "SELECT " + listColumns + " FROM discs"
	if len(where) > 0 {
		query += " WHERE " + strings.Join(where, " AND ")
	}
	query += " ORDER BY speed DESC, turn + fade DESC, brand, model"

	rows, err := s.db.QueryContext(r.Context(), query, args...)
	if err != nil {
		serverError(w, err)
		return
	}
	defer rows.Close()
	discs := []Disc{}
	for rows.Next() {
		var d Disc
		if err := rows.Scan(d.listFields()...); err != nil {
			serverError(w, err)
			return
		}
		discs = append(discs, d)
	}
	if err := rows.Err(); err != nil {
		serverError(w, err)
		return
	}
	writeJSON(w, discs)
}

// getDisc handles GET /api/discs/{id}, returning every column.
func (s *server) getDisc(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.Atoi(r.PathValue("id"))
	if err != nil {
		httpError(w, http.StatusBadRequest, "invalid id")
		return
	}
	var d Disc
	fields := append(d.listFields(), &d.DiameterCM, &d.HeightCM, &d.RimDepthCM,
		&d.RimThicknessCM, &d.MaxWeightG, &d.PDGAApproved, &d.Description)
	err = s.db.QueryRowContext(r.Context(), "SELECT "+listColumns+`,
		diameter_cm, height_cm, rim_depth_cm, rim_thickness_cm, max_weight_g,
		pdga_approved_date, description FROM discs WHERE id = ?`, id).Scan(fields...)
	if errors.Is(err, sql.ErrNoRows) {
		httpError(w, http.StatusNotFound, "no such disc")
		return
	} else if err != nil {
		serverError(w, err)
		return
	}
	writeJSON(w, d)
}

type Brand struct {
	Name      string  `json:"name"`
	Count     int     `json:"count"`
	BgColor   *string `json:"bg_color"`
	TextColor *string `json:"text_color"`
}

type Range struct {
	Min float64 `json:"min"`
	Max float64 `json:"max"`
}

type Meta struct {
	Brands     []Brand          `json:"brands"`
	Categories []string         `json:"categories"`
	Ranges     map[string]Range `json:"ranges"`
}

// meta handles GET /api/meta: the values needed to build filter controls.
func (s *server) meta(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	m := Meta{Brands: []Brand{}, Categories: []string{}, Ranges: map[string]Range{}}

	// a brand's discs all share its colors, so any row's colors will do
	rows, err := s.db.QueryContext(ctx, `SELECT brand, count(*), max(bg_color), max(text_color)
		FROM discs GROUP BY brand ORDER BY brand COLLATE NOCASE`)
	if err != nil {
		serverError(w, err)
		return
	}
	defer rows.Close()
	for rows.Next() {
		var b Brand
		if err := rows.Scan(&b.Name, &b.Count, &b.BgColor, &b.TextColor); err != nil {
			serverError(w, err)
			return
		}
		m.Brands = append(m.Brands, b)
	}

	rows, err = s.db.QueryContext(ctx, `SELECT category FROM discs WHERE category IS NOT NULL
		GROUP BY category ORDER BY count(*) DESC`)
	if err != nil {
		serverError(w, err)
		return
	}
	defer rows.Close()
	for rows.Next() {
		var c string
		if err := rows.Scan(&c); err != nil {
			serverError(w, err)
			return
		}
		m.Categories = append(m.Categories, c)
	}

	for _, f := range rangeFilters {
		var rg Range
		err := s.db.QueryRowContext(ctx, "SELECT min("+f.expr+"), max("+f.expr+") FROM discs").Scan(&rg.Min, &rg.Max)
		if err != nil {
			serverError(w, err)
			return
		}
		m.Ranges[f.param] = rg
	}
	writeJSON(w, m)
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(v); err != nil {
		log.Printf("writing response: %v", err)
	}
}

func httpError(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]string{"error": msg})
}

func serverError(w http.ResponseWriter, err error) {
	log.Printf("error: %v", err)
	httpError(w, http.StatusInternalServerError, "internal error")
}

func main() {
	dbPath := flag.String("db", "discs.db", "path to the sqlite database built by build_db.py")
	addr := flag.String("addr", "localhost:8417", "address to listen on")
	dev := flag.Bool("dev", false, "serve ./static from disk instead of the embedded copy")
	flag.Parse()

	db, err := sql.Open("sqlite", "file:"+*dbPath+"?mode=ro")
	if err != nil {
		log.Fatal(err)
	}
	if err := db.Ping(); err != nil {
		log.Fatalf("opening %s: %v", *dbPath, err)
	}
	s := &server{db: db}

	var files fs.FS
	if *dev {
		files = os.DirFS("static")
	} else {
		files, _ = fs.Sub(static, "static")
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/meta", s.meta)
	mux.HandleFunc("GET /api/discs", s.listDiscs)
	mux.HandleFunc("GET /api/discs/{id}", s.getDisc)
	mux.Handle("GET /", http.FileServerFS(files))

	log.Printf("listening on http://%s", *addr)
	log.Fatal(http.ListenAndServe(*addr, mux))
}
